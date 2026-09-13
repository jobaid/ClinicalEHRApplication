package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Step 2 of the migration: load the JSON exported by scripts/exportFirestore.mjs into PostgreSQL.
//
// Run as:  server.exe migrate [exportDir]
//
// It writes through the same Set() path and the same collection registry the live API uses, so
// there is no second field mapping that could drift out of sync. Afterwards it re-reads every
// row and compares it against the source document, and refuses to report success unless all of
// them match.
//
// Firestore is never touched by this - it only reads the exported files.

// migrationOrder puts users first so batches/ticklers referencing a uid have their owner present.
var migrationOrder = []string{
	"users", "patients", "cptCatalog", "physicians", "insurancePolicies",
	"appointments", "patientMemos", "idDocuments",
	"charges", "claims", "transactions", "batches",
	"patientCreditBalances", "insuranceCreditBalances",
	"vitals", "allergies", "medications", "problems", "clinicalNotes",
	"ticklers", "supportTickets", "auditLogs", "loginAudit",
}

type authExportUser struct {
	LocalID      string `json:"localId"`
	Email        string `json:"email"`
	PasswordHash string `json:"passwordHash"`
	Salt         string `json:"salt"`
	Disabled     bool   `json:"disabled"`
	DisplayName  string `json:"displayName"`
}

func runMigrate(ctx context.Context, db *pgxpool.Pool, dir string) error {
	fmt.Printf("Importing from %s\n\n", dir)

	loaded := map[string][]Document{}
	for _, name := range migrationOrder {
		path := filepath.Join(dir, name+".json")
		raw, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				fmt.Printf("  %-26s (no export file, skipped)\n", name)
				continue
			}
			return fmt.Errorf("read %s: %w", path, err)
		}
		var docs []Document
		if err := json.Unmarshal(raw, &docs); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
		loaded[name] = docs
	}

	// ---- write ----
	total := 0
	for _, name := range migrationOrder {
		docs, ok := loaded[name]
		if !ok {
			continue
		}
		tx, err := db.Begin(ctx)
		if err != nil {
			return err
		}
		for _, doc := range docs {
			id, _ := doc["id"].(string)
			if id == "" {
				tx.Rollback(ctx)
				return fmt.Errorf("%s: document without an id", name)
			}
			if err := Set(ctx, tx, name, id, doc); err != nil {
				tx.Rollback(ctx)
				return fmt.Errorf("%s/%s: %w", name, id, err)
			}
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		total += len(docs)
		fmt.Printf("  %-26s %5d rows\n", name, len(docs))
	}

	// ---- credentials ----
	// Password material is deliberately not part of the collections registry, so it is written
	// here directly and can never be read back out through the API.
	authPath := filepath.Join(dir, "_auth-export.json")
	if raw, err := os.ReadFile(authPath); err == nil {
		var wrapper struct {
			Users []authExportUser `json:"users"`
		}
		if err := json.Unmarshal(raw, &wrapper); err != nil {
			return fmt.Errorf("parse %s: %w", authPath, err)
		}
		withHash := 0
		for _, u := range wrapper.Users {
			if u.PasswordHash == "" {
				continue
			}
			_, err := db.Exec(ctx,
				`UPDATE users SET password_algo = 'firebase-scrypt', password_hash = $2,
				        password_salt = $3, disabled = $4
				 WHERE id = $1`,
				u.LocalID, u.PasswordHash, u.Salt, u.Disabled)
			if err != nil {
				return fmt.Errorf("credentials for %s: %w", u.Email, err)
			}
			withHash++
		}
		fmt.Printf("  %-26s %5d credentials\n", "(auth)", withHash)
	} else {
		fmt.Printf("  %-26s no auth export found - nobody will be able to sign in\n", "(auth)")
	}

	fmt.Printf("\nImported %d documents.\n\n", total)

	// ---- verify ----
	return verifyMigration(ctx, db, loaded)
}

// verifyMigration re-reads every migrated row through the API's own read path and compares it
// against the source document field by field.
//
// A NULL column reads back as JSON null while the source document may simply have omitted the
// field. Those are treated as equivalent - every consumer in the app tests these with `||`,
// `?.` or truthiness, where undefined and null behave identically - but any other difference,
// including a changed value or a lost field, is a hard failure.
func verifyMigration(ctx context.Context, db *pgxpool.Pool, loaded map[string][]Document) error {
	fmt.Println("Verifying every migrated document against its source")

	totalDocs, totalFields, mismatches := 0, 0, 0
	for _, name := range migrationOrder {
		srcDocs, ok := loaded[name]
		if !ok {
			continue
		}
		got, err := List(ctx, db, name)
		if err != nil {
			return err
		}
		byID := map[string]Document{}
		for _, d := range got {
			id, _ := d["id"].(string)
			byID[id] = d
		}

		colMismatch := 0
		if len(got) != len(srcDocs) {
			fmt.Printf("  %-26s COUNT MISMATCH: expected %d, found %d\n", name, len(srcDocs), len(got))
			mismatches++
			continue
		}

		for _, src := range srcDocs {
			id, _ := src["id"].(string)
			dst, present := byID[id]
			if !present {
				fmt.Printf("  %s/%s MISSING after import\n", name, id)
				colMismatch++
				continue
			}
			totalDocs++
			for k, want := range src {
				totalFields++
				have, exists := dst[k]
				if !exists && want == nil {
					continue
				}
				if !equalJSON(want, have) {
					if colMismatch < 5 {
						fmt.Printf("  %s/%s field %q: source=%s imported=%s\n",
							name, id, k, brief(want), brief(have))
					}
					colMismatch++
				}
			}
		}
		status := "ok"
		if colMismatch > 0 {
			status = fmt.Sprintf("%d MISMATCHES", colMismatch)
			mismatches += colMismatch
		}
		fmt.Printf("  %-26s %5d docs  %s\n", name, len(srcDocs), status)
	}

	fmt.Printf("\nCompared %d documents / %d fields.\n", totalDocs, totalFields)
	if mismatches > 0 {
		return fmt.Errorf("verification FAILED: %d mismatches", mismatches)
	}
	fmt.Println("VERIFICATION PASSED - every field round-tripped intact.")
	return nil
}

// equalJSON compares two decoded-JSON values structurally, with null and absent treated alike.
func equalJSON(a, b any) bool {
	if a == nil && b == nil {
		return true
	}
	// Numbers may arrive as int (from Firestore) or float64 (from NUMERIC); compare numerically.
	if af, aok := toFloat(a); aok {
		if bf, bok := toFloat(b); bok {
			return af == bf
		}
		return false
	}
	ja, err1 := marshalStable(a)
	jb, err2 := marshalStable(b)
	if err1 != nil || err2 != nil {
		return false
	}
	return ja == jb
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

// marshalStable renders a value with map keys sorted, so two structurally equal objects that
// were built in a different order still compare equal.
func marshalStable(v any) (string, error) {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		out := "{"
		for i, k := range keys {
			if i > 0 {
				out += ","
			}
			sub, err := marshalStable(t[k])
			if err != nil {
				return "", err
			}
			out += fmt.Sprintf("%q:%s", k, sub)
		}
		return out + "}", nil
	case []any:
		out := "["
		for i, e := range t {
			if i > 0 {
				out += ","
			}
			sub, err := marshalStable(e)
			if err != nil {
				return "", err
			}
			out += sub
		}
		return out + "]", nil
	default:
		raw, err := json.Marshal(v)
		return string(raw), err
	}
}

func brief(v any) string {
	raw, _ := json.Marshal(v)
	if len(raw) > 60 {
		return string(raw[:60]) + "..."
	}
	return string(raw)
}
