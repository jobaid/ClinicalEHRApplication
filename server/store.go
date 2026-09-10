package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Document is one record as the React app sees it: a free-form JSON object that always has "id".
type Document map[string]any

// ---------- read ----------

// selectList builds the column list for a SELECT, always ending with `extra`.
func (c *Collection) selectList() string {
	cols := make([]string, 0, len(c.Fields)+1)
	for _, fl := range c.Fields {
		cols = append(cols, fl.Col)
	}
	cols = append(cols, "extra")
	return strings.Join(cols, ", ")
}

// scanRow turns one SQL row back into the document shape the app expects.
//
// NULL text columns come back as JSON null (Firestore stored explicit nulls for
// chargeInsuranceId, payerOverride, closedAt, ... and the app checks for them), while `extra`
// is merged last so a field that was only ever in the catch-all still round-trips.
func (c *Collection) scanRow(rows pgx.Rows) (Document, error) {
	dest := make([]any, 0, len(c.Fields)+1)
	strs := make([]*string, len(c.Fields))
	nums := make([]*float64, len(c.Fields))
	bools := make([]*bool, len(c.Fields))
	jsons := make([][]byte, len(c.Fields))

	for i, fl := range c.Fields {
		switch fl.Kind {
		case KText:
			dest = append(dest, &strs[i])
		case KNum:
			dest = append(dest, &nums[i])
		case KBool:
			dest = append(dest, &bools[i])
		case KJSON:
			dest = append(dest, &jsons[i])
		}
	}
	var extraRaw []byte
	dest = append(dest, &extraRaw)

	if err := rows.Scan(dest...); err != nil {
		return nil, err
	}

	doc := Document{}
	for i, fl := range c.Fields {
		switch fl.Kind {
		case KText:
			if strs[i] == nil {
				doc[fl.Name] = nil
			} else {
				doc[fl.Name] = *strs[i]
			}
		case KNum:
			if nums[i] == nil {
				doc[fl.Name] = nil
			} else {
				doc[fl.Name] = *nums[i]
			}
		case KBool:
			if bools[i] == nil {
				doc[fl.Name] = nil
			} else {
				doc[fl.Name] = *bools[i]
			}
		case KJSON:
			if len(jsons[i]) > 0 {
				var v any
				if err := json.Unmarshal(jsons[i], &v); err != nil {
					return nil, fmt.Errorf("field %s: %w", fl.Name, err)
				}
				doc[fl.Name] = v
			}
		}
	}

	if len(extraRaw) > 0 {
		var extra map[string]any
		if err := json.Unmarshal(extraRaw, &extra); err == nil {
			for k, v := range extra {
				doc[k] = v
			}
		}
	}
	return doc, nil
}

// List returns every document in a collection. The app reads whole collections and filters
// client-side, exactly as it did with Firestore's onSnapshot.
func List(ctx context.Context, db *pgxpool.Pool, name string) ([]Document, error) {
	c, ok := collections[name]
	if !ok {
		return nil, fmt.Errorf("unknown collection %q", name)
	}
	rows, err := db.Query(ctx, fmt.Sprintf("SELECT %s FROM %s", c.selectList(), c.Table))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Document{}
	for rows.Next() {
		doc, err := c.scanRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, doc)
	}
	return out, rows.Err()
}

func Get(ctx context.Context, db *pgxpool.Pool, name, id string) (Document, error) {
	c, ok := collections[name]
	if !ok {
		return nil, fmt.Errorf("unknown collection %q", name)
	}
	rows, err := db.Query(ctx, fmt.Sprintf("SELECT %s FROM %s WHERE id = $1", c.selectList(), c.Table), id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, nil
	}
	return c.scanRow(rows)
}

// ---------- write ----------

// split divides an incoming document into values for the typed columns and whatever is left
// over for the `extra` catch-all. `id` is handled separately as the primary key.
func (c *Collection) split(doc Document) (cols []string, vals []any, extra map[string]any) {
	known := c.byName()
	extra = map[string]any{}
	for k, v := range doc {
		fl, isKnown := known[k]
		if !isKnown {
			extra[k] = v
			continue
		}
		if fl.Name == "id" {
			continue // primary key, written explicitly
		}
		cols = append(cols, fl.Col)
		vals = append(vals, coerce(fl, v))
	}
	return cols, vals, extra
}

// coerce converts a JSON value into something the pgx driver can bind to the column's type.
// JSONB columns are re-marshalled; everything else passes through, with nil preserved so an
// explicit null in the document becomes a real SQL NULL.
func coerce(fl Field, v any) any {
	if fl.Kind == KJSON {
		if v == nil {
			return nil
		}
		raw, err := json.Marshal(v)
		if err != nil {
			return nil
		}
		return raw
	}
	return v
}

// Set replaces a document wholesale (Firestore setDoc semantics): fields absent from the
// payload revert to their column defaults rather than keeping their previous value.
func Set(ctx context.Context, tx pgx.Tx, name, id string, doc Document) error {
	c, ok := collections[name]
	if !ok {
		return fmt.Errorf("unknown collection %q", name)
	}
	cols, vals, extra := c.split(doc)

	extraRaw, err := json.Marshal(extra)
	if err != nil {
		return err
	}

	// Rewrite the row from scratch so removed fields do not linger.
	if _, err := tx.Exec(ctx, fmt.Sprintf("DELETE FROM %s WHERE id = $1", c.Table), id); err != nil {
		return err
	}

	allCols := append([]string{"id"}, cols...)
	allCols = append(allCols, "extra")
	allVals := append([]any{id}, vals...)
	allVals = append(allVals, extraRaw)

	ph := make([]string, len(allVals))
	for i := range allVals {
		ph[i] = fmt.Sprintf("$%d", i+1)
	}
	sql := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)",
		c.Table, strings.Join(allCols, ", "), strings.Join(ph, ", "))
	_, err = tx.Exec(ctx, sql, allVals...)
	return err
}

// Update merges fields into an existing row (Firestore updateDoc semantics): untouched columns
// keep their values, and the `extra` object is merged rather than replaced.
func Update(ctx context.Context, tx pgx.Tx, name, id string, doc Document) error {
	c, ok := collections[name]
	if !ok {
		return fmt.Errorf("unknown collection %q", name)
	}
	cols, vals, extra := c.split(doc)

	sets := make([]string, 0, len(cols)+1)
	args := make([]any, 0, len(vals)+2)
	for i, col := range cols {
		sets = append(sets, fmt.Sprintf("%s = $%d", col, len(args)+1))
		args = append(args, vals[i])
		_ = i
	}
	if len(extra) > 0 {
		extraRaw, err := json.Marshal(extra)
		if err != nil {
			return err
		}
		sets = append(sets, fmt.Sprintf("extra = extra || $%d::jsonb", len(args)+1))
		args = append(args, extraRaw)
	}
	if len(sets) == 0 {
		return nil
	}
	args = append(args, id)
	sql := fmt.Sprintf("UPDATE %s SET %s WHERE id = $%d", c.Table, strings.Join(sets, ", "), len(args))
	ct, err := tx.Exec(ctx, sql, args...)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("no such document %s/%s", name, id)
	}
	return nil
}

func Delete(ctx context.Context, tx pgx.Tx, name, id string) error {
	c, ok := collections[name]
	if !ok {
		return fmt.Errorf("unknown collection %q", name)
	}
	_, err := tx.Exec(ctx, fmt.Sprintf("DELETE FROM %s WHERE id = $1", c.Table), id)
	return err
}
