package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// IP and device access administration for the Super Admin.
//
// Three concerns kept apart:
//   1. Extracting the effective client IP behind a reverse proxy, safely.
//   2. Enforcing allow / block rules on that IP for authenticated requests.
//   3. Recording an access event, and looking up VPN / proxy status through a pluggable provider.
//
// Nothing here is on by default in a way that could lock an installation out. IP block rules
// exist only when an administrator creates one; the middleware never fabricates a rule. The VPN
// policy defaults to MONITOR - detections are recorded but never used to deny. Both switches are
// deliberately explicit.

// ---------- schema init ----------

//go:embed migrations/020_ip_device_access.sql
var ipDeviceSchemaSQL string

func (s *Server) ensureIPDeviceSchema(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, ipDeviceSchemaSQL); err != nil {
		return fmt.Errorf("ip/device schema: %w", err)
	}
	return nil
}

// ---------- effective client IP ----------
//
// The application may sit behind nginx, CloudPanel, or another reverse proxy that terminates TLS
// and forwards to the API. Trusting X-Forwarded-For from the world lets any client claim any IP,
// so we ONLY honour it when the immediate peer is a trusted proxy. TRUSTED_PROXIES is a
// comma-separated list of CIDR blocks the operator declares.

var (
	trustedProxyNets     []*net.IPNet
	trustedProxyNetsOnce sync.Once
)

func loadTrustedProxies() []*net.IPNet {
	trustedProxyNetsOnce.Do(func() {
		raw := os.Getenv("TRUSTED_PROXIES")
		if raw == "" {
			// Docker's default bridge network + Docker Compose defaults + loopback. Widening
			// beyond this must be explicit; production behind CloudPanel typically adds the host's
			// public IP or the reverse-proxy container's subnet.
			raw = "127.0.0.1/32,::1/128,172.16.0.0/12,10.0.0.0/8,192.168.0.0/16"
		}
		for _, part := range strings.Split(raw, ",") {
			cidr := strings.TrimSpace(part)
			if cidr == "" {
				continue
			}
			if _, n, err := net.ParseCIDR(cidr); err == nil {
				trustedProxyNets = append(trustedProxyNets, n)
			}
		}
	})
	return trustedProxyNets
}

func isTrustedProxy(ip net.IP) bool {
	for _, n := range loadTrustedProxies() {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// clientIP returns the effective client IP as a string, honouring X-Forwarded-For only when the
// immediate peer is a trusted proxy. The RIGHTMOST forwarded entry is treated as the closest
// hop to the trusted proxy; anything to the left of that may have been added by a client.
func clientIP(r *http.Request) string {
	peer := remoteHost(r.RemoteAddr)
	peerIP := net.ParseIP(peer)
	if peerIP == nil {
		return peer
	}
	if !isTrustedProxy(peerIP) {
		return peer
	}
	xff := r.Header.Get("X-Forwarded-For")
	if xff == "" {
		if xr := r.Header.Get("X-Real-IP"); xr != "" {
			return strings.TrimSpace(xr)
		}
		return peer
	}
	// Walk right-to-left. Return the first entry that is not itself a trusted proxy.
	parts := strings.Split(xff, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		s := strings.TrimSpace(parts[i])
		ip := net.ParseIP(s)
		if ip == nil {
			continue
		}
		if isTrustedProxy(ip) {
			continue
		}
		return s
	}
	return peer
}

func remoteHost(addr string) string {
	if h, _, err := net.SplitHostPort(addr); err == nil {
		return h
	}
	return addr
}

// ---------- IP rule enforcement ----------

type ipDecision struct {
	Decision string // "allow" | "block" | "none"
	Rule     string // rule id when a rule matched
	Reason   string
}

// evaluateIP checks the active rules. An explicit allow rule wins over a block rule (so an
// administrator can carve a single IP out of a wider block), matching the least-surprise
// interpretation. No rule means no decision, which the caller reads as allow.
func (s *Server) evaluateIP(ctx context.Context, ip string) ipDecision {
	if ip == "" {
		return ipDecision{Decision: "none"}
	}
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return ipDecision{Decision: "none"}
	}
	rows, err := s.db.Query(ctx,
		`SELECT id, cidr, mode, reason FROM ip_access_rules
		  WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`)
	if err != nil {
		return ipDecision{Decision: "none"}
	}
	defer rows.Close()
	var allow, block *ipDecision
	for rows.Next() {
		var id, cidr, mode, reason string
		if err := rows.Scan(&id, &cidr, &mode, &reason); err != nil {
			continue
		}
		if !cidrContains(cidr, parsed) {
			continue
		}
		d := ipDecision{Decision: mode, Rule: id, Reason: reason}
		if mode == "allow" && allow == nil {
			allow = &d
		}
		if mode == "block" && block == nil {
			block = &d
		}
	}
	if allow != nil {
		return *allow
	}
	if block != nil {
		return *block
	}
	return ipDecision{Decision: "none"}
}

func cidrContains(cidr string, ip net.IP) bool {
	if !strings.Contains(cidr, "/") {
		return net.ParseIP(cidr).Equal(ip)
	}
	_, n, err := net.ParseCIDR(cidr)
	if err != nil {
		return false
	}
	return n.Contains(ip)
}

// ipAccessEnforce returns true when the middleware should refuse a blocked IP.
//
// Enforcement is ON by default and only turned off when IP_ACCESS_ENFORCE is explicitly set to
// "false". That matches the natural expectation - "I added a block rule, so it should block" -
// and the lockout risk stays covered by the SUPER_ADMIN bypass, which never blocks the account
// that can create and revoke rules.
func ipAccessEnforce() bool {
	return !strings.EqualFold(os.Getenv("IP_ACCESS_ENFORCE"), "false")
}

// vpnPolicyMode returns "monitor" or "block". "monitor" is the safe default and never denies.
func vpnPolicyMode() string {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("VPN_POLICY")))
	if v == "block" {
		return "block"
	}
	return "monitor"
}

// enforceRequestAccess is the middleware wrapper for authenticated routes. Called AFTER
// requireAuth, so blocks apply per authenticated request and cannot be tricked by an unauthed
// probe. A SUPER_ADMIN is never blocked, which is the lockout guarantee section 17 asks for.
func (s *Server) enforceRequestAccess(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFrom(r.Context())
		ip := clientIP(r)
		if u.Role != "SUPER_ADMIN" && ipAccessEnforce() {
			d := s.evaluateIP(r.Context(), ip)
			if d.Decision == "block" {
				s.recordAccessEvent(r.Context(), u, ip, r.UserAgent(), r.URL.Path,
					"blocked_ip", "block", "unchecked", "", d.Reason)
				writeErr(w, http.StatusForbidden,
					"access from this network is not permitted by the organization's security policy")
				return
			}
		}
		next(w, r)
	}
}

// recordAccessEvent writes one row to access_events. Best-effort: a database hiccup must not
// break a request that already passed authorisation.
func (s *Server) recordAccessEvent(ctx context.Context, u authedUser, ip, ua, path, action, decision, vpnStatus, vpnSource, reason string) {
	if len(ua) > 400 {
		ua = ua[:400]
	}
	_, _ = s.db.Exec(ctx,
		`INSERT INTO access_events
		  (id, user_id, user_email, role, ip, ua_short, action, path, decision, vpn_status, vpn_source, reason)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		"AE"+newUID(), u.UID, u.Email, u.Role, ip, ua, action, path, decision, vpnStatus, vpnSource, reason)
}

// ---------- VPN / proxy detection ----------

const vpnCacheTTL = 24 * time.Hour

type vpnResult struct {
	Status string // clean | vpn | proxy | tor | datacenter | unknown
	Source string
}

// vpnLookup returns the cached result if fresh, otherwise queries the configured provider and
// stores the answer. A missing provider returns "unchecked" so the caller can record honestly
// rather than falsely reporting "clean".
func (s *Server) vpnLookup(ctx context.Context, ip string) vpnResult {
	if ip == "" || net.ParseIP(ip) == nil {
		return vpnResult{Status: "unchecked"}
	}
	var status, source string
	var checked time.Time
	err := s.db.QueryRow(ctx,
		`SELECT status, source, checked_at FROM vpn_ip_cache WHERE ip = $1`, ip).Scan(&status, &source, &checked)
	if err == nil && time.Since(checked) < vpnCacheTTL {
		return vpnResult{Status: status, Source: source}
	}

	res := callVPNProvider(ctx, ip)
	if res.Status == "" {
		res.Status = "unchecked"
	}
	// Only cache real answers, not "unchecked" (unconfigured) or "unknown" (transient error).
	if res.Status != "unchecked" && res.Status != "unknown" {
		_, _ = s.db.Exec(ctx,
			`INSERT INTO vpn_ip_cache (ip, status, source, checked_at)
			 VALUES ($1, $2, $3, now())
			 ON CONFLICT (ip) DO UPDATE
			    SET status = EXCLUDED.status, source = EXCLUDED.source, checked_at = now()`,
			ip, res.Status, res.Source)
	}
	return res
}

// callVPNProvider dispatches to the configured provider. Two are wired: ipqualityscore.com
// (recommended for accuracy) and ipapi.is (open, adequate for many uses). Add more by inserting
// another case.
func callVPNProvider(ctx context.Context, ip string) vpnResult {
	prov := strings.ToLower(strings.TrimSpace(os.Getenv("VPN_PROVIDER")))
	if prov == "" {
		return vpnResult{Status: "unchecked"}
	}
	switch prov {
	case "ipqualityscore":
		return vpnLookupIPQS(ctx, ip)
	case "ipapi.is", "ipapi_is":
		return vpnLookupIPAPI(ctx, ip)
	default:
		return vpnResult{Status: "unchecked"}
	}
}

func vpnLookupIPQS(ctx context.Context, ip string) vpnResult {
	key := strings.TrimSpace(os.Getenv("IPQS_API_KEY"))
	if key == "" {
		return vpnResult{Status: "unchecked"}
	}
	u := "https://ipqualityscore.com/api/json/ip/" + key + "/" + ip
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return vpnResult{Status: "unknown"}
	}
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return vpnResult{Status: "unknown"}
	}
	defer resp.Body.Close() //nolint:errcheck
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var out struct {
		Success    bool `json:"success"`
		Proxy      bool `json:"proxy"`
		VPN        bool `json:"vpn"`
		Tor        bool `json:"tor"`
		ActiveVPN  bool `json:"active_vpn"`
		ActiveTor  bool `json:"active_tor"`
		Datacenter bool `json:"is_datacenter"`
	}
	if err := json.Unmarshal(body, &out); err != nil || !out.Success {
		return vpnResult{Status: "unknown", Source: "ipqualityscore"}
	}
	switch {
	case out.Tor || out.ActiveTor:
		return vpnResult{Status: "tor", Source: "ipqualityscore"}
	case out.VPN || out.ActiveVPN:
		return vpnResult{Status: "vpn", Source: "ipqualityscore"}
	case out.Proxy:
		return vpnResult{Status: "proxy", Source: "ipqualityscore"}
	case out.Datacenter:
		return vpnResult{Status: "datacenter", Source: "ipqualityscore"}
	}
	return vpnResult{Status: "clean", Source: "ipqualityscore"}
}

func vpnLookupIPAPI(ctx context.Context, ip string) vpnResult {
	key := strings.TrimSpace(os.Getenv("IPAPI_IS_KEY"))
	u := "https://api.ipapi.is/?ip=" + ip
	if key != "" {
		u += "&key=" + key
	}
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return vpnResult{Status: "unknown"}
	}
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return vpnResult{Status: "unknown"}
	}
	defer resp.Body.Close() //nolint:errcheck
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	var out struct {
		IsBogon      bool `json:"is_bogon"`
		IsMobile     bool `json:"is_mobile"`
		IsSatellite  bool `json:"is_satellite"`
		IsCrawler    bool `json:"is_crawler"`
		IsDatacenter bool `json:"is_datacenter"`
		IsTor        bool `json:"is_tor"`
		IsProxy      bool `json:"is_proxy"`
		IsVPN        bool `json:"is_vpn"`
		IsAbuser     bool `json:"is_abuser"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return vpnResult{Status: "unknown", Source: "ipapi.is"}
	}
	switch {
	case out.IsTor:
		return vpnResult{Status: "tor", Source: "ipapi.is"}
	case out.IsVPN:
		return vpnResult{Status: "vpn", Source: "ipapi.is"}
	case out.IsProxy:
		return vpnResult{Status: "proxy", Source: "ipapi.is"}
	case out.IsDatacenter:
		return vpnResult{Status: "datacenter", Source: "ipapi.is"}
	}
	return vpnResult{Status: "clean", Source: "ipapi.is"}
}

// ---------- admin endpoints ----------

type ipRule struct {
	ID           string `json:"id"`
	CIDR         string `json:"cidr"`
	Mode         string `json:"mode"`
	Reason       string `json:"reason"`
	CreatedBy    string `json:"createdBy"`
	CreatedAt    string `json:"createdAt"`
	ExpiresAt    string `json:"expiresAt"`
	RevokedAt    string `json:"revokedAt"`
	RevokedBy    string `json:"revokedBy"`
	RevokedReason string `json:"revokedReason"`
	Active       bool   `json:"active"`
}

// GET /api/admin/ip-access/rules
func (s *Server) handleIPRuleList(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(),
		`SELECT id, cidr, mode, reason, created_by, created_at, expires_at, revoked_at,
		        revoked_by, revoked_reason
		   FROM ip_access_rules ORDER BY created_at DESC LIMIT 500`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read IP rules")
		return
	}
	defer rows.Close()
	out := []ipRule{}
	for rows.Next() {
		var v ipRule
		var created time.Time
		var expires, revoked *time.Time
		if err := rows.Scan(&v.ID, &v.CIDR, &v.Mode, &v.Reason, &v.CreatedBy, &created,
			&expires, &revoked, &v.RevokedBy, &v.RevokedReason); err != nil {
			continue
		}
		v.CreatedAt = created.UTC().Format(time.RFC3339)
		if expires != nil {
			v.ExpiresAt = expires.UTC().Format(time.RFC3339)
		}
		if revoked != nil {
			v.RevokedAt = revoked.UTC().Format(time.RFC3339)
		}
		v.Active = revoked == nil && (expires == nil || expires.After(time.Now()))
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"rules":     out,
		"enforcing": ipAccessEnforce(),
		"vpnPolicy": vpnPolicyMode(),
		"vpnProvider": strings.TrimSpace(os.Getenv("VPN_PROVIDER")),
	})
}

// POST /api/admin/ip-access/rules
func (s *Server) handleIPRuleCreate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var body struct {
		CIDR       string `json:"cidr"`
		Mode       string `json:"mode"`
		Reason     string `json:"reason"`
		ExpiresAt  string `json:"expiresAt"` // RFC3339 or empty
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	body.CIDR = strings.TrimSpace(body.CIDR)
	body.Mode = strings.ToLower(strings.TrimSpace(body.Mode))
	if body.Mode != "block" && body.Mode != "allow" {
		writeErr(w, http.StatusBadRequest, "mode must be 'block' or 'allow'")
		return
	}
	if !validCIDROrIP(body.CIDR) {
		writeErr(w, http.StatusBadRequest, "cidr must be an IPv4/IPv6 address or CIDR block")
		return
	}
	var expires any
	if s := strings.TrimSpace(body.ExpiresAt); s != "" {
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "expiresAt must be RFC3339 (e.g. 2026-09-30T17:00:00Z)")
			return
		}
		if t.Before(time.Now()) {
			writeErr(w, http.StatusBadRequest, "expiresAt is already in the past")
			return
		}
		expires = t.UTC()
	}
	id := "IPR" + newUID()
	if _, err := s.db.Exec(r.Context(),
		`INSERT INTO ip_access_rules (id, cidr, mode, reason, created_by, expires_at)
		 VALUES ($1,$2,$3,$4,$5,$6)`,
		id, body.CIDR, body.Mode, strings.TrimSpace(body.Reason), u.Name, expires); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create the rule")
		return
	}
	s.recordAccessEvent(r.Context(), u, clientIP(r), r.UserAgent(), r.URL.Path,
		"rule_create", body.Mode, "unchecked", "",
		fmt.Sprintf("%s %s (%s)", body.Mode, body.CIDR, body.Reason))
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

// DELETE /api/admin/ip-access/rules/{id}
func (s *Server) handleIPRuleRevoke(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")
	reason := strings.TrimSpace(r.URL.Query().Get("reason"))
	tag, err := s.db.Exec(r.Context(),
		`UPDATE ip_access_rules SET revoked_at = now(), revoked_by = $2, revoked_reason = $3
		  WHERE id = $1 AND revoked_at IS NULL`,
		id, u.Name, reason)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not revoke the rule")
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "no such active rule")
		return
	}
	s.recordAccessEvent(r.Context(), u, clientIP(r), r.UserAgent(), r.URL.Path,
		"rule_revoke", "allow", "unchecked", "", reason)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// GET /api/admin/ip-access/events
func (s *Server) handleAccessEventList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	args := []any{}
	where := "TRUE"
	if v := strings.TrimSpace(q.Get("ip")); v != "" {
		args = append(args, "%"+v+"%")
		where += fmt.Sprintf(" AND ip ILIKE $%d", len(args))
	}
	if v := strings.TrimSpace(q.Get("user")); v != "" {
		args = append(args, "%"+v+"%")
		where += fmt.Sprintf(" AND (user_email ILIKE $%d OR user_id ILIKE $%d)", len(args), len(args))
	}
	if v := strings.TrimSpace(q.Get("action")); v != "" {
		args = append(args, v)
		where += fmt.Sprintf(" AND action = $%d", len(args))
	}
	limit := 200
	sqlStr := "SELECT id, user_id, user_email, role, ip, ua_short, action, path, decision, vpn_status, vpn_source, reason, at " +
		"FROM access_events WHERE " + where + " ORDER BY at DESC LIMIT " + itoa(limit)
	rows, err := s.db.Query(r.Context(), sqlStr, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read access events")
		return
	}
	defer rows.Close()
	type row struct {
		ID, UserID, UserEmail, Role, IP, UA, Action, Path, Decision, VPN, VPNSource, Reason string
		At time.Time
	}
	out := []map[string]any{}
	for rows.Next() {
		var v row
		if err := rows.Scan(&v.ID, &v.UserID, &v.UserEmail, &v.Role, &v.IP, &v.UA,
			&v.Action, &v.Path, &v.Decision, &v.VPN, &v.VPNSource, &v.Reason, &v.At); err != nil {
			continue
		}
		out = append(out, map[string]any{
			"id": v.ID, "userId": v.UserID, "userEmail": v.UserEmail, "role": v.Role,
			"ip": v.IP, "userAgent": v.UA, "action": v.Action, "path": v.Path,
			"decision": v.Decision, "vpnStatus": v.VPN, "vpnSource": v.VPNSource,
			"reason": v.Reason, "at": v.At.UTC().Format(time.RFC3339),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": out})
}

// DELETE /api/admin/ip-access/events - Super Admin clears the access-events audit log.
//
// Restricted to SUPER_ADMIN even though the route is behind IP_ACCESS_MANAGE, because clearing
// the security audit is a stricter act than editing rules - the trail should not disappear on
// anyone but the account that owns the practice.
func (s *Server) handleAccessEventsClear(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	if u.Role != "SUPER_ADMIN" {
		writeErr(w, http.StatusForbidden, "only a Super Admin may clear the access events")
		return
	}
	// TRUNCATE resets the whole table cheaply; the current admin's own action is then re-recorded
	// so the audit is never truly empty of the moment it was cleared.
	if _, err := s.db.Exec(r.Context(), `TRUNCATE TABLE access_events`); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not clear the access events")
		return
	}
	s.recordAccessEvent(r.Context(), u, clientIP(r), r.UserAgent(), r.URL.Path,
		"events_cleared", "allow", "unchecked", "", "audit log cleared by Super Admin")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// POST /api/admin/ip-access/check - manual VPN lookup for one IP.
func (s *Server) handleIPCheck(w http.ResponseWriter, r *http.Request) {
	var body struct{ IP string `json:"ip"` }
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	if !validCIDROrIP(body.IP) {
		writeErr(w, http.StatusBadRequest, "ip must be a valid IPv4 or IPv6 address")
		return
	}
	res := s.vpnLookup(r.Context(), body.IP)
	writeJSON(w, http.StatusOK, map[string]any{
		"ip":     body.IP,
		"status": res.Status,
		"source": res.Source,
	})
}

// GET /api/admin/ip-access/users - one row per user with their most recent login event.
//
// Grouped in SQL rather than in Go so the response is small and the whole users table stays out
// of the API. A user who has never signed in since the feature was deployed simply does not
// appear here; their history begins when they next log in.
func (s *Server) handleAccessUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `
		SELECT DISTINCT ON (u.id)
		       u.id, u.email, u.name, u.role, u.disabled,
		       COALESCE(e.ip, ''),
		       COALESCE(e.ua_short, ''),
		       COALESCE(e.vpn_status, ''),
		       COALESCE(e.vpn_source, ''),
		       e.at
		  FROM users u
		  LEFT JOIN access_events e ON e.user_id = u.id AND e.action = 'login'
		 ORDER BY u.id, e.at DESC NULLS LAST`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the user summary")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var uid, email, name, role, ip, ua, vpn, vpnSrc string
		var disabled bool
		var at *time.Time
		if err := rows.Scan(&uid, &email, &name, &role, &disabled, &ip, &ua, &vpn, &vpnSrc, &at); err != nil {
			continue
		}
		lastAt := ""
		if at != nil {
			lastAt = at.UTC().Format(time.RFC3339)
		}
		out = append(out, map[string]any{
			"userId": uid, "email": email, "name": name, "role": role, "disabled": disabled,
			"lastIP": ip, "userAgent": ua, "vpnStatus": vpn, "vpnSource": vpnSrc,
			"lastLoginAt": lastAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out})
}

func validCIDROrIP(s string) bool {
	if s == "" {
		return false
	}
	if strings.Contains(s, "/") {
		_, _, err := net.ParseCIDR(s)
		return err == nil
	}
	return net.ParseIP(s) != nil
}
