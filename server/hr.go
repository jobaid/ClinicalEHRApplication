package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// HR workforce search, filtering, sorting and pagination.
//
// Four rules shape this file.
//
// First, EVERY today-status is DERIVED, never stored. Whether somebody is present, late, on leave
// or off is a fact about a date, computed from the schedule, the attendance record, the approved
// leave requests and the holiday calendar. Section 4 requires exactly that, and storing a status
// on the employee row would be wrong the moment the date changed.
//
// Second, the derivation lives in SQL rather than in Go. That is not a preference - filtering on a
// value computed in Go would mean fetching every employee to find the matching page, which section
// 20 forbids and which stops working at the first thousand-employee practice. The derivation is a
// CASE expression inside a CTE, so the same expression serves the list, the filters and the counts,
// and they cannot disagree with each other.
//
// Third, the SELECT LIST depends on the caller's grants. Section 22: restricted fields are not sent
// and then hidden in React, they are never selected. A caller without HR_EMPLOYEE_VIEW does not
// receive a hire date at all.
//
// Fourth, nothing here touches patient data. There is no join to patients, charges, claims,
// medical_records, lab_results or prescriptions anywhere in this file - section 23.

//go:embed migrations/014_hr_workforce.sql
var hrSchemaSQL string

func (s *Server) ensureHRSchema(ctx context.Context) error {
	if _, err := s.db.Exec(ctx, hrSchemaSQL); err != nil {
		return fmt.Errorf("hr schema: %w", err)
	}
	return nil
}

// ---------- the derivation ----------

// workforceCTE is the single source of truth for what a workforce row is.
//
// $1 is the workforce date. Every column the filters, the sorts and the counts reference is defined
// here exactly once, which is what stops the list and the quick-filter counts from drifting apart.
//
// The today_status precedence is deliberate and worth reading in order:
//
//	HOLIDAY         a company holiday, and the employee is not scheduled to work it
//	PTO / SICK      an APPROVED leave request covers the date - a pending one is not leave
//	attendance      what was actually recorded: PRESENT, LATE, REMOTE, ABSENT, CALLED_OFF, SICK
//	DAY_OFF         no schedule for the date, or the schedule says day off
//	NOT_CLOCKED_IN  scheduled, not on leave, and nothing recorded yet
//
// Approved leave outranks a recorded attendance status on purpose: if somebody is on approved PTO
// and an attendance row exists for that date, the leave is the authoritative fact and the
// attendance row is the anomaly worth seeing rather than silently honouring.
const workforceCTE = `
WITH wf AS (
  SELECT
    u.id                                   AS user_id,
    u.name                                 AS name,
    u.email                                AS email,
    u.disabled                             AS login_disabled,
    e.employee_no                          AS employee_no,
    e.employment_type                       AS employment_type,
    e.employment_status                     AS employment_status,
    e.work_arrangement                      AS work_arrangement,
    e.hire_date                             AS hire_date,
    e.termination_date                      AS termination_date,
    e.work_phone                            AS work_phone,
    e.photo_url                             AS photo_url,
    coalesce(d.name, '')                    AS department,
    coalesce(e.department_id, '')                  AS department_id,
    coalesce(jt.name, '')                   AS job_title,
    coalesce(e.job_title_id, '')                  AS job_title_id,
    coalesce(l.name, '')                    AS location,
    coalesce(e.location_id, '')                  AS location_id,
    coalesce(m.name, '')                    AS manager,
    e.manager_user_id                        AS manager_user_id,
    coalesce(sh.name, '')                   AS shift_name,
    coalesce(sh.id, '')                     AS shift_id,
    -- Rendered as text here: pgx maps a bare TIME to pgtype.Time, not time.Time, so scanning
    -- one into a *time.Time fails at runtime rather than at compile time.
    to_char(sch.start_time, 'HH24:MI')       AS start_time,
    to_char(sch.end_time,   'HH24:MI')       AS end_time,
    -- Scheduled means a row exists for the date that is not marked as a day off. No row at all is
    -- not scheduled: a practice that has not published next week's rota has nobody scheduled,
    -- which is the truthful answer rather than assuming a default week.
    (sch.user_id IS NOT NULL AND NOT sch.is_day_off) AS is_scheduled,
    att.status                               AS attendance_status,
    att.clock_in                             AS clock_in,
    att.clock_out                            AS clock_out,
    att.minutes_late                         AS minutes_late,
    pto.leave_type                           AS leave_type,
    (pto.id IS NOT NULL)                     AS on_leave,
    coalesce(hol.name, '')                   AS holiday_name,
    (hol.holiday_date IS NOT NULL)           AS is_holiday,
    CASE
      WHEN hol.holiday_date IS NOT NULL
           AND (sch.user_id IS NULL OR sch.is_day_off) THEN 'HOLIDAY'
      WHEN pto.id IS NOT NULL AND pto.leave_type = 'SICK' THEN 'SICK'
      WHEN pto.id IS NOT NULL THEN 'PTO'
      WHEN att.status <> '' AND att.status IS NOT NULL THEN att.status
      WHEN sch.user_id IS NULL OR sch.is_day_off THEN 'DAY_OFF'
      ELSE 'NOT_CLOCKED_IN'
    END                                      AS today_status,
    -- Counted here so the credential and training filters need no extra round trip.
    (SELECT count(*) FROM employee_credentials c
      WHERE c.user_id = e.user_id AND c.expiry_date IS NOT NULL
        AND c.expiry_date < $1)              AS credentials_expired,
    (SELECT min(c.expiry_date) FROM employee_credentials c
      WHERE c.user_id = e.user_id AND c.expiry_date IS NOT NULL
        AND c.expiry_date >= $1)             AS next_credential_expiry,
    (SELECT count(*) FROM employee_training t
      WHERE t.user_id = e.user_id AND t.completed_date IS NULL
        AND t.due_date IS NOT NULL AND t.due_date < $1) AS training_overdue,
    (SELECT min(t.due_date) FROM employee_training t
      WHERE t.user_id = e.user_id AND t.completed_date IS NULL
        AND t.due_date IS NOT NULL AND t.due_date >= $1) AS next_training_due,
    (SELECT count(*) FROM pto_requests pr
      WHERE pr.user_id = e.user_id AND pr.status = 'PENDING') AS pending_requests
  FROM employees e
  JOIN users u                  ON u.id = e.user_id
  LEFT JOIN hr_departments d    ON d.id = e.department_id
  LEFT JOIN hr_job_titles jt    ON jt.id = e.job_title_id
  LEFT JOIN hr_work_locations l ON l.id = e.location_id
  LEFT JOIN users m             ON m.id = e.manager_user_id
  LEFT JOIN employee_schedules sch ON sch.user_id = e.user_id AND sch.work_date = $1
  LEFT JOIN hr_shifts sh        ON sh.id = coalesce(sch.shift_id, e.default_shift_id)
  LEFT JOIN employee_attendance att ON att.user_id = e.user_id AND att.work_date = $1
  LEFT JOIN pto_requests pto    ON pto.user_id = e.user_id AND pto.status = 'APPROVED'
                                AND $1 BETWEEN pto.start_date AND pto.end_date
  LEFT JOIN company_holidays hol ON hol.holiday_date = $1
)`

// workforceCols is the column list the row scanner expects, in order.
//
// Named explicitly rather than using SELECT *, because the scan below is positional: with SELECT *
// a column inserted into the middle of the CTE would shift every field after it and the failure
// would be silently wrong data rather than an error.
const workforceCols = `user_id, name, email, login_disabled, employee_no,
	employment_type, employment_status, work_arrangement,
	hire_date, termination_date, work_phone, photo_url,
	department, department_id, job_title, job_title_id,
	location, location_id, manager, manager_user_id,
	shift_name, shift_id, start_time, end_time, is_scheduled,
	attendance_status, clock_in, clock_out, minutes_late,
	leave_type, on_leave, holiday_name, is_holiday, today_status,
	credentials_expired, next_credential_expiry, training_overdue, next_training_due,
	pending_requests`

// todayPredicates maps each quick filter to a predicate over the CTE.
//
// They deliberately OVERLAP, because the questions HR asks overlap: somebody present today is also
// working today and also scheduled today. Modelling these as one enum would force a false choice.
var todayPredicates = map[string]string{
	"scheduled":  "is_scheduled",
	"working":    "is_scheduled AND attendance_status IN ('PRESENT','LATE','REMOTE')",
	"present":    "attendance_status = 'PRESENT'",
	"late":       "attendance_status = 'LATE'",
	"absent":     "attendance_status = 'ABSENT'",
	"called_off": "attendance_status = 'CALLED_OFF'",
	"sick":       "(attendance_status = 'SICK' OR (on_leave AND leave_type = 'SICK'))",
	"pto":        "on_leave",
	// Remote reads the recorded attendance first and falls back to the employee's arrangement when
	// nothing has been recorded yet, so a remote worker shows as remote before they clock in.
	"remote":         "(attendance_status = 'REMOTE' OR (attendance_status IS NULL AND work_arrangement = 'REMOTE'))",
	"day_off":        "NOT is_scheduled",
	"holiday":        "is_holiday",
	"not_clocked_in": "is_scheduled AND NOT on_leave AND clock_in IS NULL",
}

// sortable maps a client sort key to a SQL expression. A whitelist, because ORDER BY cannot be
// parameterised - interpolating a client string here would be an injection.
var sortable = map[string]string{
	"name":           "lower(name)",
	"employeeNo":     "employee_no",
	"department":     "lower(department)",
	"jobTitle":       "lower(job_title)",
	"manager":        "lower(manager)",
	"location":       "lower(location)",
	"hireDate":       "hire_date",
	"scheduleStart":  "start_time",
	"attendance":     "today_status",
	"employmentType": "lower(employment_type)",
	"status":         "lower(employment_status)",
}

// ---------- filter assembly ----------

type filterBuilder struct {
	where []string
	args  []any
}

func (f *filterBuilder) add(clause string, arg any) {
	f.args = append(f.args, arg)
	f.where = append(f.where, fmt.Sprintf(clause, len(f.args)))
}

func (f *filterBuilder) raw(clause string) { f.where = append(f.where, clause) }

func (f *filterBuilder) clause() string {
	if len(f.where) == 0 {
		return ""
	}
	// Section 10: AND between filter categories.
	return " WHERE " + strings.Join(f.where, "\n    AND ")
}

// parseDate accepts YYYY-MM-DD and reports whether it was usable. An unparseable date is refused
// rather than silently replaced with today, because "who was absent yesterday" answered with
// today's data is worse than an error.
func parseDate(s string) (time.Time, bool) {
	d, err := time.Parse("2006-01-02", strings.TrimSpace(s))
	return d, err == nil
}

// buildWorkforceFilters turns the query string into predicates over the CTE.
//
// The workforce date is arg $1 and is added by the caller, so every predicate added here numbers
// from $2 upward.
func buildWorkforceFilters(q map[string][]string, asOf time.Time, access hrFieldAccess) *filterBuilder {
	f := &filterBuilder{args: []any{asOf}}

	get := func(k string) string {
		if v := q[k]; len(v) > 0 {
			return strings.TrimSpace(v[0])
		}
		return ""
	}

	// Free-text search across the identifying fields listed in section 2. One parameter, matched
	// against several columns - a name, an id, an email, a phone, a title, a department, a manager
	// or a location, because a user typing into one box does not want to choose which.
	if term := get("search"); term != "" {
		// Email and work phone are searched ONLY for a caller who may see them.
		//
		// Otherwise search becomes a way to confirm a field the caller cannot read: someone
		// without HR_EMPLOYEE_VIEW could try phone numbers until one returned a row. Matching on
		// a field you are not allowed to see is a slower version of being shown it.
		cols := []string{"name", "employee_no", "job_title", "department", "manager", "location"}
		if access.Employee {
			cols = append(cols, "email", "work_phone")
		}
		parts := make([]string, len(cols))
		for i, c := range cols {
			parts[i] = c + ` ILIKE '%%'||$%[1]d||'%%'`
		}
		f.add("("+strings.Join(parts, " OR ")+")", term)
	}

	for key, col := range map[string]string{
		"departmentId":     "department_id",
		"jobTitleId":       "job_title_id",
		"managerId":        "manager_user_id",
		"locationId":       "location_id",
		"shiftId":          "shift_id",
		"employmentType":   "employment_type",
		"employmentStatus": "employment_status",
		"workArrangement":  "work_arrangement",
	} {
		if v := get(key); v != "" {
			f.add(col+" = $%d", v)
		}
	}

	// Today's workforce status (section 4). Several may be supplied; they are OR-ed with each
	// other and AND-ed with everything else, so "present or late" narrows within the category
	// rather than fighting the department filter.
	if states := q["today"]; len(states) > 0 {
		var parts []string
		for _, st := range states {
			if p, ok := todayPredicates[strings.ToLower(strings.TrimSpace(st))]; ok {
				parts = append(parts, "("+p+")")
			}
		}
		if len(parts) > 0 {
			f.raw("(" + strings.Join(parts, " OR ") + ")")
		}
	}

	// Leave (section 6). Scoped to the workforce date and the week around it.
	switch get("ptoStatus") {
	case "today":
		f.raw("on_leave")
	case "pending":
		f.raw("pending_requests > 0")
	case "this_week":
		f.raw(`EXISTS (SELECT 1 FROM pto_requests pr WHERE pr.user_id = wf.user_id
		        AND pr.status = 'APPROVED'
		        AND pr.end_date   >= date_trunc('week', $1::date)::date
		        AND pr.start_date <= (date_trunc('week', $1::date) + interval '6 days')::date)`)
	case "next_week":
		f.raw(`EXISTS (SELECT 1 FROM pto_requests pr WHERE pr.user_id = wf.user_id
		        AND pr.status = 'APPROVED'
		        AND pr.end_date   >= (date_trunc('week', $1::date) + interval '7 days')::date
		        AND pr.start_date <= (date_trunc('week', $1::date) + interval '13 days')::date)`)
	case "upcoming":
		f.raw(`EXISTS (SELECT 1 FROM pto_requests pr WHERE pr.user_id = wf.user_id
		        AND pr.status = 'APPROVED' AND pr.start_date > $1::date)`)
	}
	if lt := get("leaveType"); lt != "" {
		f.add("leave_type = $%d", lt)
	}

	// Hire date and tenure (section 8), both computed from the stored hire date.
	if v, ok := parseDate(get("hiredFrom")); ok {
		f.add("hire_date >= $%d", v)
	}
	if v, ok := parseDate(get("hiredTo")); ok {
		f.add("hire_date <= $%d", v)
	}
	switch get("hiredWithin") {
	case "week":
		f.raw("hire_date >= ($1::date - interval '7 days')::date")
	case "month":
		f.raw("hire_date >= ($1::date - interval '1 month')::date")
	case "year":
		f.raw("hire_date >= ($1::date - interval '1 year')::date")
	}
	switch get("tenure") {
	case "under_90":
		f.raw("hire_date > ($1::date - interval '90 days')::date")
	case "under_1y":
		f.raw("hire_date > ($1::date - interval '1 year')::date")
	case "1_3y":
		f.raw(`hire_date <= ($1::date - interval '1 year')::date
		   AND hire_date >  ($1::date - interval '3 years')::date`)
	case "3_5y":
		f.raw(`hire_date <= ($1::date - interval '3 years')::date
		   AND hire_date >  ($1::date - interval '5 years')::date`)
	case "5y_plus":
		f.raw("hire_date <= ($1::date - interval '5 years')::date")
	}

	// Credentials and training (section 9).
	switch get("credential") {
	case "expired":
		f.raw("credentials_expired > 0")
	case "expiring":
		if days := get("withinDays"); days != "" {
			if n, err := strconv.Atoi(days); err == nil && n > 0 && n <= 365 {
				f.raw(fmt.Sprintf(
					"next_credential_expiry IS NOT NULL AND next_credential_expiry <= ($1::date + interval '%d days')::date", n))
			}
		} else {
			f.raw("next_credential_expiry IS NOT NULL AND next_credential_expiry <= ($1::date + interval '30 days')::date")
		}
	}
	switch get("training") {
	case "overdue":
		f.raw("training_overdue > 0")
	case "due":
		if days := get("withinDays"); days != "" {
			if n, err := strconv.Atoi(days); err == nil && n > 0 && n <= 365 {
				f.raw(fmt.Sprintf(
					"next_training_due IS NOT NULL AND next_training_due <= ($1::date + interval '%d days')::date", n))
			}
		} else {
			f.raw("next_training_due IS NOT NULL AND next_training_due <= ($1::date + interval '30 days')::date")
		}
	}

	return f
}

// ---------- the workforce list ----------

// authorized field sets. A caller who lacks the grant does not get the column.
type hrFieldAccess struct {
	Employee   bool // hire date, tenure, work phone, email, employee number
	Credential bool // credential and training expiry
}

func (s *Server) hrAccess(ctx context.Context, u authedUser) hrFieldAccess {
	perms := s.effectiveUserPerms(ctx, u.UID, u.Role)
	return hrFieldAccess{
		Employee:   perms.has(PermHREmployeeView),
		Credential: perms.has(PermHRCredentialView),
	}
}

// GET /api/hr/workforce
func (s *Server) handleWorkforceList(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	access := s.hrAccess(r.Context(), u)
	q := r.URL.Query()

	asOf := time.Now()
	if v, ok := parseDate(q.Get("date")); ok {
		asOf = v
	} else if raw := strings.TrimSpace(q.Get("date")); raw != "" {
		writeErr(w, http.StatusBadRequest, "the workforce date must be YYYY-MM-DD")
		return
	}

	f := buildWorkforceFilters(q, asOf, access)
	where := f.clause()

	// Sorting. An unrecognised key falls back to name rather than erroring, but it is never
	// interpolated.
	order := sortable["name"]
	if expr, ok := sortable[q.Get("sort")]; ok {
		order = expr
	}
	dir := "ASC"
	if strings.EqualFold(q.Get("dir"), "desc") {
		dir = "DESC"
	}

	limit := 50
	if n, err := strconv.Atoi(q.Get("limit")); err == nil && n > 0 && n <= 200 {
		limit = n
	}
	page := 1
	if n, err := strconv.Atoi(q.Get("page")); err == nil && n > 0 {
		page = n
	}
	offset := (page - 1) * limit

	// Total first, so pagination can report "1-50 of 1,247" (section 20) against the same filters.
	var total int
	if err := s.db.QueryRow(r.Context(),
		workforceCTE+" SELECT count(*) FROM wf"+where, f.args...).Scan(&total); err != nil {
		log.Printf("hr: workforce count failed: %v", err)
		writeErr(w, http.StatusInternalServerError, "could not read the workforce")
		return
	}

	args := append(append([]any{}, f.args...), limit, offset)
	rows, err := s.db.Query(r.Context(), fmt.Sprintf(
		"%s SELECT %s FROM wf%s ORDER BY %s %s NULLS LAST, lower(name) ASC LIMIT $%d OFFSET $%d",
		workforceCTE, workforceCols, where, order, dir, len(args)-1, len(args)), args...)
	if err != nil {
		log.Printf("hr: workforce query failed: %v", err)
		writeErr(w, http.StatusInternalServerError, "could not read the workforce")
		return
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var (
			userID, name, email, employeeNo                   string
			employmentType, employmentStatus, workArrangement string
			workPhone, photoURL                               string
			department, departmentID, jobTitle, jobTitleID    string
			location, locationID, manager, shiftName, shiftID string
			managerUserID                                     *string
			holidayName, todayStatus                          string
			attendanceStatus, leaveType                       *string
			loginDisabled, isScheduled, onLeave, isHoliday    bool
			hireDate, terminationDate                         *time.Time
			nextCredExpiry, nextTrainingDue                   *time.Time
			startTime, endTime                                *string
			clockIn, clockOut                                 *time.Time
			minutesLate                                       *int
			credsExpired, trainingOverdue, pendingRequests    int
		)
		if err := rows.Scan(
			&userID, &name, &email, &loginDisabled, &employeeNo,
			&employmentType, &employmentStatus, &workArrangement,
			&hireDate, &terminationDate, &workPhone, &photoURL,
			&department, &departmentID, &jobTitle, &jobTitleID,
			&location, &locationID, &manager, &managerUserID,
			&shiftName, &shiftID, &startTime, &endTime, &isScheduled,
			&attendanceStatus, &clockIn, &clockOut, &minutesLate,
			&leaveType, &onLeave, &holidayName, &isHoliday, &todayStatus,
			&credsExpired, &nextCredExpiry, &trainingOverdue, &nextTrainingDue, &pendingRequests,
		); err != nil {
			// Not a silent continue. A row that cannot be scanned is a row the count included and
			// the list did not, which reads to a user as staff disappearing - the bug this
			// replaced. Failing the request makes it a visible error instead of missing people.
			log.Printf("hr: workforce scan failed: %v", err)
			writeErr(w, http.StatusInternalServerError,
				"the workforce could not be read completely - the server log has the detail")
			return
		}

		row := map[string]any{
			"userId": userID, "name": name, "employeeNo": employeeNo,
			"department": department, "departmentId": departmentID,
			"jobTitle": jobTitle, "jobTitleId": jobTitleID,
			"location": location, "locationId": locationID,
			"manager": manager, "photoUrl": photoURL,
			"employmentType": employmentType, "employmentStatus": employmentStatus,
			"workArrangement": workArrangement,
			"shift":           shiftName,
			"scheduleStart":   deref(startTime),
			"scheduleEnd":     deref(endTime),
			"isScheduled":     isScheduled,
			"todayStatus":     todayStatus,
			"attendance":      deref(attendanceStatus),
			"onLeave":         onLeave,
			"leaveType":       deref(leaveType),
			"holiday":         holidayName,
			"pendingRequests": pendingRequests,
		}
		// Section 22: these are not selected-then-hidden, they are omitted from the response.
		if access.Employee {
			row["email"] = email
			row["workPhone"] = workPhone
			row["hireDate"] = dateOrEmpty(hireDate)
			row["terminationDate"] = dateOrEmpty(terminationDate)
			row["loginDisabled"] = loginDisabled
			row["clockIn"] = tsOrEmpty(clockIn)
			row["clockOut"] = tsOrEmpty(clockOut)
			if minutesLate != nil {
				row["minutesLate"] = *minutesLate
			}
		}
		if access.Credential {
			row["credentialsExpired"] = credsExpired
			row["nextCredentialExpiry"] = dateOrEmpty(nextCredExpiry)
			row["trainingOverdue"] = trainingOverdue
			row["nextTrainingDue"] = dateOrEmpty(nextTrainingDue)
		}
		out = append(out, row)
	}

	pages := 0
	if limit > 0 {
		pages = (total + limit - 1) / limit
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"employees": out,
		"page":      page, "limit": limit, "total": total, "pages": pages,
		"from": min(offset+1, total), "to": min(offset+len(out), total),
		"date": asOf.Format("2006-01-02"),
		// Stated so the interface can render only the columns it was actually given data for,
		// rather than guessing which grants the caller holds.
		"fields": map[string]bool{"employee": access.Employee, "credential": access.Credential},
	})
}

// GET /api/hr/workforce/counts - the quick-filter counts (section 12).
//
// Computed from the SAME CTE and the SAME filters as the list, so a count can never disagree with
// the rows behind it. The only thing dropped is the today filter itself, because each count is that
// filter applied on its own.
func (s *Server) handleWorkforceCounts(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	asOf := time.Now()
	if v, ok := parseDate(q.Get("date")); ok {
		asOf = v
	}

	// The today filter is excluded: each count IS a today filter.
	base := map[string][]string{}
	for k, v := range q {
		if k != "today" {
			base[k] = v
		}
	}
	// The counts use the caller's own field access, so a search term behaves identically here and
	// in the list - a count that matched on a hidden column would leak exactly what the list will
	// not show.
	f := buildWorkforceFilters(base, asOf, s.hrAccess(r.Context(), userFrom(r.Context())))
	where := f.clause()

	// One query, one pass. A count per state as a FILTER aggregate rather than twelve round trips.
	var parts []string
	keys := []string{
		"scheduled", "working", "present", "late", "absent", "called_off",
		"sick", "pto", "remote", "day_off", "holiday", "not_clocked_in",
	}
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("count(*) FILTER (WHERE %s)", todayPredicates[k]))
	}
	parts = append(parts, "count(*)", "count(*) FILTER (WHERE pending_requests > 0)")

	row := s.db.QueryRow(r.Context(),
		workforceCTE+" SELECT "+strings.Join(parts, ", ")+" FROM wf"+where, f.args...)

	vals := make([]int, len(keys)+2)
	targets := make([]any, len(vals))
	for i := range vals {
		targets[i] = &vals[i]
	}
	if err := row.Scan(targets...); err != nil {
		log.Printf("hr: workforce counts failed: %v", err)
		writeErr(w, http.StatusInternalServerError, "could not read the workforce counts")
		return
	}

	counts := map[string]int{}
	for i, k := range keys {
		counts[k] = vals[i]
	}
	counts["all"] = vals[len(keys)]
	counts["pending_requests"] = vals[len(keys)+1]

	writeJSON(w, http.StatusOK, map[string]any{
		"counts": counts,
		"date":   asOf.Format("2006-01-02"),
	})
}

// GET /api/hr/options - the configured values the filter dropdowns offer.
//
// Read from the database rather than hard-coded in React, so renaming a department or adding a
// shift does not need a deploy (section 3, section 7).
func (s *Server) handleHROptions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	out := map[string]any{}

	lookup := func(key, query string) {
		rows, err := s.db.Query(ctx, query)
		if err != nil {
			out[key] = []any{}
			return
		}
		defer rows.Close()
		list := []map[string]any{}
		for rows.Next() {
			var id, label string
			if rows.Scan(&id, &label) == nil {
				list = append(list, map[string]any{"id": id, "label": label})
			}
		}
		out[key] = list
	}

	lookup("departments", `SELECT id, name FROM hr_departments WHERE active ORDER BY lower(name)`)
	lookup("jobTitles", `SELECT id, name FROM hr_job_titles WHERE active ORDER BY lower(name)`)
	lookup("locations", `SELECT id, name FROM hr_work_locations WHERE active ORDER BY lower(name)`)
	lookup("shifts", `SELECT id, name || ' (' || to_char(start_time,'HH24:MI') || '-' ||
	                  to_char(end_time,'HH24:MI') || ')' FROM hr_shifts WHERE active ORDER BY sort_order`)
	// Managers are employees who manage somebody. Derived rather than flagged, so it cannot go
	// stale when a reporting line changes.
	lookup("managers", `SELECT DISTINCT u.id, u.name FROM employees e
	                    JOIN users u ON u.id = e.manager_user_id
	                    WHERE e.manager_user_id IS NOT NULL ORDER BY u.name`)

	for key, domain := range map[string]string{
		"employmentTypes":    "hr_employment_type",
		"employmentStatuses": "hr_employment_status",
		"workArrangements":   "hr_work_arrangement",
		"attendanceStatuses": "hr_attendance",
		"leaveTypes":         "hr_leave_type",
	} {
		lookup(key, fmt.Sprintf(
			`SELECT code, label FROM workflow_statuses WHERE domain = '%s' AND active ORDER BY sort_order`,
			domain))
	}

	writeJSON(w, http.StatusOK, out)
}

// ---------- saved views (section 18) ----------

// GET /api/hr/saved-views
func (s *Server) handleHRSavedViewList(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	// Own views, plus any explicitly shared. Section 18: a saved view belongs to its owner.
	rows, err := s.db.Query(r.Context(), `
		SELECT id, name, filters, shared, user_id = $1 AS mine
		  FROM hr_saved_views WHERE user_id = $1 OR shared ORDER BY lower(name)`, u.UID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the saved views")
		return
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var id, name string
		var raw []byte
		var shared, mine bool
		if rows.Scan(&id, &name, &raw, &shared, &mine) != nil {
			continue
		}
		var filters map[string]any
		_ = json.Unmarshal(raw, &filters)
		out = append(out, map[string]any{
			"id": id, "name": name, "filters": filters, "shared": shared, "mine": mine,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"views": out})
}

// POST /api/hr/saved-views
func (s *Server) handleHRSavedViewSave(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var b struct {
		Name    string         `json:"name"`
		Filters map[string]any `json:"filters"`
		Shared  bool           `json:"shared"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	name := strings.TrimSpace(b.Name)
	if name == "" {
		writeErr(w, http.StatusBadRequest, "a name is required")
		return
	}
	if b.Filters == nil {
		b.Filters = map[string]any{}
	}
	// A saved view holds filter selections only. Nothing about an employee is stored in it, so a
	// shared view cannot leak a name or an id to somebody who could not already search for it.
	raw, err := json.Marshal(b.Filters)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "the filters could not be stored")
		return
	}
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO hr_saved_views (id, user_id, name, filters, shared)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (user_id, lower(name))
		DO UPDATE SET filters = EXCLUDED.filters, shared = EXCLUDED.shared, updated_at = now()`,
		"HRV"+newUID(), u.UID, name, raw, b.Shared); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the view")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"saved": true, "name": name})
}

// DELETE /api/hr/saved-views/{id} - only ever the caller's own.
func (s *Server) handleHRSavedViewDelete(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	tag, err := s.db.Exec(r.Context(),
		`DELETE FROM hr_saved_views WHERE id = $1 AND user_id = $2`, r.PathValue("id"), u.UID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not delete the view")
		return
	}
	if tag.RowsAffected() == 0 {
		// Covers both "no such view" and "somebody else's view" with one answer, so the response
		// cannot be used to discover that another user's view exists.
		writeErr(w, http.StatusNotFound, "view not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// ---------- export (section 19) ----------

// GET /api/hr/workforce/export - CSV of the CURRENT filtered, authorized results.
//
// Behind HR_REPORT_EXPORT, and it re-applies the same filters and the same field authorization as
// the list: an export cannot become a way to obtain a column the caller cannot see on screen.
func (s *Server) handleWorkforceExport(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	access := s.hrAccess(r.Context(), u)
	q := r.URL.Query()

	asOf := time.Now()
	if v, ok := parseDate(q.Get("date")); ok {
		asOf = v
	}
	f := buildWorkforceFilters(q, asOf, access)
	where := f.clause()

	// An export has no page. It is capped so a mistaken click cannot pull an unbounded result set.
	// An export has no page, so it is capped: a mistaken click must not pull an unbounded set.
	const exportCap = 5000
	args := append(append([]any{}, f.args...), exportCap)
	rows, err := s.db.Query(r.Context(), fmt.Sprintf(
		"%s SELECT %s FROM wf%s ORDER BY lower(name) LIMIT $%d",
		workforceCTE, workforceCols, where, len(args)), args...)
	if err != nil {
		log.Printf("hr: export query failed: %v", err)
		writeErr(w, http.StatusInternalServerError, "could not build the export")
		return
	}
	defer rows.Close()

	cols := []string{"Employee", "Employee ID", "Department", "Job Title", "Manager",
		"Location", "Employment Type", "Employment Status", "Work Arrangement",
		"Shift", "Scheduled", "Today Status"}
	if access.Employee {
		cols = append(cols, "Email", "Work Phone", "Hire Date")
	}
	if access.Credential {
		cols = append(cols, "Credentials Expired", "Next Credential Expiry",
			"Training Overdue", "Next Training Due")
	}

	var b strings.Builder
	b.WriteString(strings.Join(cols, ",") + "\n")

	n := 0
	for rows.Next() && n < exportCap {
		vals, err := rows.Values()
		if err != nil {
			continue
		}
		byName := map[string]any{}
		for i, fd := range rows.FieldDescriptions() {
			byName[string(fd.Name)] = vals[i]
		}
		rec := []string{
			csvStr(byName["name"]), csvStr(byName["employee_no"]), csvStr(byName["department"]),
			csvStr(byName["job_title"]), csvStr(byName["manager"]), csvStr(byName["location"]),
			csvStr(byName["employment_type"]), csvStr(byName["employment_status"]),
			csvStr(byName["work_arrangement"]), csvStr(byName["shift_name"]),
			csvStr(byName["is_scheduled"]), csvStr(byName["today_status"]),
		}
		if access.Employee {
			rec = append(rec, csvStr(byName["email"]), csvStr(byName["work_phone"]),
				csvStr(byName["hire_date"]))
		}
		if access.Credential {
			rec = append(rec, csvStr(byName["credentials_expired"]),
				csvStr(byName["next_credential_expiry"]),
				csvStr(byName["training_overdue"]), csvStr(byName["next_training_due"]))
		}
		b.WriteString(strings.Join(rec, ",") + "\n")
		n++
	}

	// Audited (section 19). The row COUNT and the filters are recorded, not the employee names -
	// an audit trail should say what was taken, not repeat its contents.
	s.auditHR(r.Context(), u, "Workforce export",
		fmt.Sprintf("%d rows, date %s, filters %s", n, asOf.Format("2006-01-02"), filterSummary(q)))

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="workforce-%s.csv"`, asOf.Format("2006-01-02")))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(b.String()))
}

// ---------- helpers ----------

func (s *Server) auditHR(ctx context.Context, u authedUser, action, detail string) {
	_, err := s.db.Exec(ctx,
		`INSERT INTO audit_logs (id, patient_id, "user", action, entity_type, entity_id, old_values, new_values, timestamp)
		 VALUES ($1,NULL,$2,$3,'hr','',$4,$5,$6)`,
		"AUD"+newUID(), u.Name, action, "", clip(detail, 400),
		time.Now().Format("2006-01-02T15:04:05"))
	if err != nil {
		log.Printf("hr: audit write failed for %q: %v", action, err)
	}
}

// filterSummary renders the applied filters for the audit trail. Only filter KEYS and their
// values, which are department ids and status codes - never an employee's details.
func filterSummary(q map[string][]string) string {
	var parts []string
	for _, k := range []string{"search", "departmentId", "jobTitleId", "managerId", "locationId",
		"employmentType", "employmentStatus", "workArrangement", "shiftId", "ptoStatus",
		"tenure", "credential", "training"} {
		if v := q[k]; len(v) > 0 && strings.TrimSpace(v[0]) != "" {
			// The search term is reported as present rather than quoted: it can be a person's name.
			if k == "search" {
				parts = append(parts, "search=(term)")
				continue
			}
			parts = append(parts, k+"="+v[0])
		}
	}
	if v := q["today"]; len(v) > 0 {
		parts = append(parts, "today="+strings.Join(v, "|"))
	}
	if len(parts) == 0 {
		return "none"
	}
	return strings.Join(parts, " ")
}

func csvStr(v any) string {
	var s string
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		s = t
	case bool:
		if t {
			return "Yes"
		}
		return "No"
	case time.Time:
		s = t.Format("2006-01-02")
	default:
		s = fmt.Sprint(t)
	}
	if strings.ContainsAny(s, `",`+"\n") {
		return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}

func dateOrEmpty(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.Format("2006-01-02")
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ---------- the employee profile (section 16) ----------

// GET /api/hr/employees/{id}
//
// Section 16 asks for the existing Employee Profile to be reused rather than duplicated. There was
// no HR module in this application before this change, so there was no profile to reuse - this is
// that one profile, created once, and the Workforce screen links to it rather than rendering its own
// version of an employee's details.
//
// Field authorization is the SAME as the list: a caller without HR_EMPLOYEE_VIEW does not receive
// an email, a phone, a hire date or attendance times here either. A detail view is the obvious place
// for a permission check to be forgotten, which is why it shares hrAccess with the list.
func (s *Server) handleHREmployeeProfile(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	access := s.hrAccess(r.Context(), u)
	id := r.PathValue("id")

	asOf := time.Now()
	if v, ok := parseDate(r.URL.Query().Get("date")); ok {
		asOf = v
	}

	var (
		userID, name, email, employeeNo                   string
		employmentType, employmentStatus, workArrangement string
		workPhone, photoURL                               string
		department, jobTitle, location, manager           string
		hireDate, terminationDate                         *time.Time
		loginDisabled                                     bool
	)
	err := s.db.QueryRow(r.Context(), `
		SELECT u.id, u.name, u.email, u.disabled, e.employee_no,
		       e.employment_type, e.employment_status, e.work_arrangement,
		       e.work_phone, e.photo_url,
		       coalesce(d.name,''), coalesce(jt.name,''), coalesce(l.name,''), coalesce(m.name,''),
		       e.hire_date, e.termination_date
		  FROM employees e
		  JOIN users u ON u.id = e.user_id
		  LEFT JOIN hr_departments d    ON d.id = e.department_id
		  LEFT JOIN hr_job_titles jt    ON jt.id = e.job_title_id
		  LEFT JOIN hr_work_locations l ON l.id = e.location_id
		  LEFT JOIN users m             ON m.id = e.manager_user_id
		 WHERE e.user_id = $1`, id).
		Scan(&userID, &name, &email, &loginDisabled, &employeeNo,
			&employmentType, &employmentStatus, &workArrangement,
			&workPhone, &photoURL,
			&department, &jobTitle, &location, &manager,
			&hireDate, &terminationDate)
	if err != nil {
		writeErr(w, http.StatusNotFound, "employee not found")
		return
	}

	out := map[string]any{
		"userId": userID, "name": name, "employeeNo": employeeNo,
		"department": department, "jobTitle": jobTitle, "location": location, "manager": manager,
		"employmentType": employmentType, "employmentStatus": employmentStatus,
		"workArrangement": workArrangement, "photoUrl": photoURL,
	}
	if access.Employee {
		out["email"] = email
		out["workPhone"] = workPhone
		out["hireDate"] = dateOrEmpty(hireDate)
		out["terminationDate"] = dateOrEmpty(terminationDate)
		out["loginDisabled"] = loginDisabled
	}

	// The fortnight around the chosen date: enough to answer "what has this person been doing"
	// without becoming an attendance report.
	from := asOf.AddDate(0, 0, -7)
	to := asOf.AddDate(0, 0, 7)

	days := []map[string]any{}
	rows, err := s.db.Query(r.Context(), `
		SELECT d::date,
		       to_char(sch.start_time,'HH24:MI'), to_char(sch.end_time,'HH24:MI'),
		       coalesce(sch.is_day_off,FALSE), coalesce(sh.name,''),
		       coalesce(att.status,''), coalesce(pto.leave_type,''), coalesce(hol.name,'')
		  FROM generate_series($2::date, $3::date, interval '1 day') d
		  LEFT JOIN employee_schedules sch ON sch.user_id = $1 AND sch.work_date = d::date
		  LEFT JOIN hr_shifts sh          ON sh.id = sch.shift_id
		  LEFT JOIN employee_attendance att ON att.user_id = $1 AND att.work_date = d::date
		  LEFT JOIN pto_requests pto      ON pto.user_id = $1 AND pto.status = 'APPROVED'
		                                 AND d::date BETWEEN pto.start_date AND pto.end_date
		  LEFT JOIN company_holidays hol   ON hol.holiday_date = d::date
		 ORDER BY d`, id, from, to)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var day time.Time
			var start, end, shift, att, leave, holiday *string
			var dayOff bool
			if rows.Scan(&day, &start, &end, &dayOff, &shift, &att, &leave, &holiday) != nil {
				continue
			}
			days = append(days, map[string]any{
				"date": day.Format("2006-01-02"), "start": deref(start), "end": deref(end),
				"isDayOff": dayOff, "shift": deref(shift),
				"attendance": deref(att), "leaveType": deref(leave), "holiday": deref(holiday),
			})
		}
	}
	out["days"] = days

	if access.Credential {
		creds := []map[string]any{}
		cr, err := s.db.Query(r.Context(), `
			SELECT credential_type, identifier, issuing_body, issued_date, expiry_date
			  FROM employee_credentials WHERE user_id = $1 ORDER BY expiry_date NULLS LAST`, id)
		if err == nil {
			defer cr.Close()
			for cr.Next() {
				var kind, ident, body string
				var issued, expiry *time.Time
				if cr.Scan(&kind, &ident, &body, &issued, &expiry) == nil {
					creds = append(creds, map[string]any{
						"type": kind, "identifier": ident, "issuingBody": body,
						"issued": dateOrEmpty(issued), "expiry": dateOrEmpty(expiry),
					})
				}
			}
		}
		out["credentials"] = creds

		training := []map[string]any{}
		tr, err := s.db.Query(r.Context(), `
			SELECT course, due_date, completed_date FROM employee_training
			 WHERE user_id = $1 ORDER BY due_date NULLS LAST`, id)
		if err == nil {
			defer tr.Close()
			for tr.Next() {
				var course string
				var due, done *time.Time
				if tr.Scan(&course, &due, &done) == nil {
					training = append(training, map[string]any{
						"course": course, "due": dateOrEmpty(due), "completed": dateOrEmpty(done),
					})
				}
			}
		}
		out["training"] = training
	}

	// Leave requests are shown to anyone who can see the workforce: "who is off next week" is the
	// question this screen exists to answer. The REASON for leave is deliberately not returned -
	// that can be a medical matter, and nothing on this screen needs it.
	leave := []map[string]any{}
	lr, err := s.db.Query(r.Context(), `
		SELECT leave_type, status, start_date, end_date, hours
		  FROM pto_requests WHERE user_id = $1 AND end_date >= ($2::date - interval '90 days')::date
		 ORDER BY start_date DESC LIMIT 50`, id, asOf)
	if err == nil {
		defer lr.Close()
		for lr.Next() {
			var kind, status string
			var start, end time.Time
			var hours *float64
			if lr.Scan(&kind, &status, &start, &end, &hours) == nil {
				row := map[string]any{
					"leaveType": kind, "status": status,
					"start": start.Format("2006-01-02"), "end": end.Format("2006-01-02"),
				}
				if hours != nil {
					row["hours"] = *hours
				}
				leave = append(leave, row)
			}
		}
	}
	out["leave"] = leave

	writeJSON(w, http.StatusOK, out)
}
