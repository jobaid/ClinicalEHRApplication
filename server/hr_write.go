package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

// HR data entry: employees, org configuration, rota, attendance and leave.
//
// The read side is hr.go. This is everything that writes, and four rules shape it.
//
// FIRST, AND MOST IMPORTANT: creating an employee creates a USER, and this endpoint must never
// become a way to mint a working login.
//
// An employee is a user one-to-one in this application, so an employee record cannot exist without
// a users row. Every account created here is therefore written DISABLED, with a NULL password hash,
// and with a role taken from a small allowlist that cannot name SUPER_ADMIN. Giving somebody actual
// access to the application stays where it already was - the User accounts screen - which is a
// deliberate separation: the person who maintains the staff directory is not necessarily the person
// who should be able to hand out administrator accounts.
//
// SECOND: nobody is deleted. An employee who leaves gets an employment status and a termination
// date; the row, and their attendance and leave history, stay. Deleting staff records would destroy
// the history that the workforce screen exists to report on.
//
// THIRD: a decision on leave is recorded once. An approval or a refusal writes who decided and when,
// and a request that has already been decided is not re-decided - it is superseded by a new one.
//
// FOURTH: nothing here touches patient data, exactly as in hr.go.

// Roles this screen may assign. SUPER_ADMIN is absent on purpose, and so is any role that is not
// already defined by the application - a typo must not create a role that then behaves as an
// unknown one.
var assignableEmployeeRoles = map[string]bool{
	"BILLER": true, "MANAGER": true, "NURSE": true, "RECEPTIONIST": true, "DOCTOR": true,
	"HIM": true, "HUMAN_RESOURCE": true,
}

var errNotAnEmployee = errors.New("employee not found")

// takenBy reports the existing row that already holds a unique value, or "".
//
// These checks exist so a collision is reported as a sentence somebody can act on. Letting the
// unique index reject the insert works, but it surfaces as a 500 and "could not save", which tells
// the person at the screen nothing about what to change.
func (s *Server) takenBy(ctx context.Context, query string, args ...any) string {
	var id string
	if err := s.db.QueryRow(ctx, query, args...).Scan(&id); err != nil {
		return ""
	}
	return id
}

// ---------- employees ----------

type employeeInput struct {
	Name             string `json:"name"`
	Email            string `json:"email"`
	Role             string `json:"role"`
	EmployeeNo       string `json:"employeeNo"`
	DepartmentID     string `json:"departmentId"`
	JobTitleID       string `json:"jobTitleId"`
	LocationID       string `json:"locationId"`
	ManagerUserID    string `json:"managerUserId"`
	EmploymentType   string `json:"employmentType"`
	EmploymentStatus string `json:"employmentStatus"`
	WorkArrangement  string `json:"workArrangement"`
	DefaultShiftID   string `json:"defaultShiftId"`
	HireDate         string `json:"hireDate"`
	TerminationDate  string `json:"terminationDate"`
	WorkPhone        string `json:"workPhone"`

	// Not from the request body: set by the update handler from the URL, so a uniqueness check can
	// exclude the row being edited. A client cannot set it, which is the point.
	selfUserID string
}

// validate checks the input against the vocabularies actually configured in this database, rather
// than against a list compiled into the binary - a practice that adds an employment type should not
// need a deploy before it can use it.
func (s *Server) validateEmployee(ctx context.Context, in employeeInput, creating bool) []string {
	var problems []string

	if creating {
		if strings.TrimSpace(in.Name) == "" {
			problems = append(problems, "A name is required")
		}
		if e := strings.TrimSpace(in.Email); e == "" {
			problems = append(problems, "An email address is required - it identifies the account")
		} else if !strings.Contains(e, "@") || strings.ContainsAny(e, " \r\n\t") {
			problems = append(problems, "That email address is not valid")
		}
		if in.Role != "" && !assignableEmployeeRoles[in.Role] {
			problems = append(problems, "That role cannot be assigned from this screen")
		}
	}

	inDomain := func(domain, code, label string) {
		if strings.TrimSpace(code) == "" {
			return
		}
		var n int
		_ = s.db.QueryRow(ctx,
			`SELECT count(*) FROM workflow_statuses WHERE domain = $1 AND code = $2 AND active`,
			domain, code).Scan(&n)
		if n == 0 {
			problems = append(problems, label+" is not one of the configured values")
		}
	}
	inDomain("hr_employment_type", in.EmploymentType, "Employment type")
	inDomain("hr_employment_status", in.EmploymentStatus, "Employment status")
	inDomain("hr_work_arrangement", in.WorkArrangement, "Work arrangement")

	exists := func(table, id, label string) {
		if strings.TrimSpace(id) == "" {
			return
		}
		var n int
		_ = s.db.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE id = $1`, id).Scan(&n)
		if n == 0 {
			problems = append(problems, label+" does not exist")
		}
	}
	exists("hr_departments", in.DepartmentID, "That department")
	exists("hr_job_titles", in.JobTitleID, "That job title")
	exists("hr_work_locations", in.LocationID, "That work location")
	exists("hr_shifts", in.DefaultShiftID, "That shift")

	if no := strings.TrimSpace(in.EmployeeNo); no != "" {
		if other := s.takenBy(ctx,
			`SELECT user_id FROM employees WHERE employee_no = $1 AND user_id <> $2`,
			no, in.selfUserID); other != "" {
			problems = append(problems, "Employee ID "+no+" is already in use by another employee")
		}
	}

	var hire, term time.Time
	if in.HireDate != "" {
		var ok bool
		if hire, ok = parseDate(in.HireDate); !ok {
			problems = append(problems, "The hire date must be YYYY-MM-DD")
		}
	}
	if in.TerminationDate != "" {
		var ok bool
		if term, ok = parseDate(in.TerminationDate); !ok {
			problems = append(problems, "The termination date must be YYYY-MM-DD")
		} else if !hire.IsZero() && term.Before(hire) {
			problems = append(problems, "The termination date cannot be before the hire date")
		}
	}
	return problems
}

// POST /api/hr/employees
func (s *Server) handleEmployeeCreate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var in employeeInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	if problems := s.validateEmployee(r.Context(), in, true); len(problems) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error": "the employee could not be saved", "problems": problems,
		})
		return
	}

	email := strings.ToLower(strings.TrimSpace(in.Email))
	role := in.Role
	if role == "" {
		role = "RECEPTIONIST" // the least-privileged role this screen can assign
	}

	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the employee")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// An account already using this address is reported, never reused: silently attaching an
	// employee record to somebody else's existing login would be a quiet privilege transfer.
	var existing string
	if err := tx.QueryRow(r.Context(), `SELECT id FROM users WHERE lower(email) = $1`, email).
		Scan(&existing); err == nil {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "an account with that email address already exists",
			"problems": []string{
				"That email address already belongs to an account. If that person is the employee " +
					"you are adding, record their employee details against the existing account " +
					"instead of creating a second one."},
		})
		return
	}

	uid := "EMP" + newUID()
	// Disabled, and with no password. See the note at the top of this file: the staff directory
	// does not hand out access to the application.
	if _, err := tx.Exec(r.Context(), `
		INSERT INTO users (id, email, name, role, disabled, password_algo, password_hash, created_by, created_at)
		VALUES ($1,$2,$3,$4,TRUE,'bcrypt',NULL,$5,$6)`,
		uid, email, strings.TrimSpace(in.Name), role, u.Name,
		time.Now().Format("2006-01-02T15:04:05")); err != nil {
		log.Printf("hr: employee user insert failed: %v", err)
		writeErr(w, http.StatusInternalServerError, "could not save the employee")
		return
	}

	if _, err := tx.Exec(r.Context(), `
		INSERT INTO employees (user_id, employee_no, department_id, job_title_id, location_id,
		                       manager_user_id, employment_type, employment_status, work_arrangement,
		                       default_shift_id, hire_date, termination_date, work_phone)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		uid, strings.TrimSpace(in.EmployeeNo),
		nullable(in.DepartmentID), nullable(in.JobTitleID), nullable(in.LocationID),
		nullable(in.ManagerUserID), in.EmploymentType, defaultTo(in.EmploymentStatus, "ACTIVE"),
		in.WorkArrangement, nullable(in.DefaultShiftID),
		nullDate(in.HireDate), nullDate(in.TerminationDate), strings.TrimSpace(in.WorkPhone),
	); err != nil {
		log.Printf("hr: employee insert failed: %v", err)
		writeErr(w, http.StatusInternalServerError, "could not save the employee")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not save the employee")
		return
	}

	s.auditHR(r.Context(), u, "Employee created", "employee "+uid)
	writeJSON(w, http.StatusOK, map[string]any{
		"userId": uid,
		"note": "The staff record was created. The account is disabled and has no password - " +
			"give this person access to the application from User accounts in Settings if they need it.",
	})
}

// PUT /api/hr/employees/{id}
//
// Employment detail only. The name is editable here because it is the employee's name; the email
// address, the role and the password are NOT, because those are login credentials and they belong
// to the account screen.
func (s *Server) handleEmployeeUpdate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")

	var in employeeInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	in.selfUserID = id
	if problems := s.validateEmployee(r.Context(), in, false); len(problems) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error": "the employee could not be saved", "problems": problems,
		})
		return
	}
	// Nobody manages themselves. Left unchecked this produces a reporting line that no query can
	// terminate, and it is never what was meant.
	if strings.TrimSpace(in.ManagerUserID) == id {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error":    "the employee could not be saved",
			"problems": []string{"An employee cannot be their own manager"},
		})
		return
	}

	tag, err := s.db.Exec(r.Context(), `
		UPDATE employees SET
		  employee_no = $2, department_id = $3, job_title_id = $4, location_id = $5,
		  manager_user_id = $6, employment_type = $7, employment_status = $8,
		  work_arrangement = $9, default_shift_id = $10, hire_date = $11,
		  termination_date = $12, work_phone = $13, updated_at = now()
		WHERE user_id = $1`,
		id, strings.TrimSpace(in.EmployeeNo),
		nullable(in.DepartmentID), nullable(in.JobTitleID), nullable(in.LocationID),
		nullable(in.ManagerUserID), in.EmploymentType, in.EmploymentStatus,
		in.WorkArrangement, nullable(in.DefaultShiftID),
		nullDate(in.HireDate), nullDate(in.TerminationDate), strings.TrimSpace(in.WorkPhone))
	if err != nil {
		log.Printf("hr: employee update failed: %v", err)
		writeErr(w, http.StatusInternalServerError, "could not save the employee")
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, errNotAnEmployee.Error())
		return
	}

	if name := strings.TrimSpace(in.Name); name != "" {
		if _, err := s.db.Exec(r.Context(), `UPDATE users SET name = $2 WHERE id = $1`, id, name); err != nil {
			log.Printf("hr: employee name update failed: %v", err)
		}
	}

	s.auditHR(r.Context(), u, "Employee updated", "employee "+id)
	writeJSON(w, http.StatusOK, map[string]any{"saved": true})
}

// ---------- org configuration ----------

// POST /api/hr/config/{kind}
//
// Departments, job titles, locations and shifts. Creation and renaming only: there is no delete,
// because a department with history behind it cannot be removed without orphaning the employees and
// the reports that reference it. Deactivating hides it from the filters and keeps the history.
func (s *Server) handleHRConfigSave(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	kind := r.PathValue("kind")

	var b struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Code      string `json:"code"`
		City      string `json:"city"`
		State     string `json:"state"`
		StartTime string `json:"startTime"`
		EndTime   string `json:"endTime"`
		Active    *bool  `json:"active"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	name := strings.TrimSpace(b.Name)
	if name == "" && b.Active == nil {
		writeErr(w, http.StatusBadRequest, "a name is required")
		return
	}
	active := true
	if b.Active != nil {
		active = *b.Active
	}

	// A name that already belongs to a DIFFERENT row is a collision worth explaining. The same row
	// keeping its name is a rename, which must still work.
	nameTable := map[string]string{
		"departments": "hr_departments", "job-titles": "hr_job_titles",
		"locations": "hr_work_locations", "shifts": "hr_shifts",
	}[kind]
	if nameTable != "" && name != "" {
		if other := s.takenBy(r.Context(),
			`SELECT id FROM `+nameTable+` WHERE lower(name) = lower($1) AND id <> $2`,
			name, defaultTo(b.ID, "")); other != "" {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": "\"" + name + "\" already exists. Rename or reactivate the existing one " +
					"instead of adding a second with the same name.",
			})
			return
		}
	}

	var err error
	var id string
	switch kind {
	case "departments":
		id = defaultTo(b.ID, "dep_"+newUID())
		_, err = s.db.Exec(r.Context(), `
			INSERT INTO hr_departments (id, name, code, active) VALUES ($1,$2,$3,$4)
			ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, code = EXCLUDED.code,
			                               active = EXCLUDED.active`,
			id, name, strings.TrimSpace(b.Code), active)
	case "job-titles":
		id = defaultTo(b.ID, "jt_"+newUID())
		_, err = s.db.Exec(r.Context(), `
			INSERT INTO hr_job_titles (id, name, active) VALUES ($1,$2,$3)
			ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active`,
			id, name, active)
	case "locations":
		id = defaultTo(b.ID, "loc_"+newUID())
		_, err = s.db.Exec(r.Context(), `
			INSERT INTO hr_work_locations (id, name, city, state, active) VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, city = EXCLUDED.city,
			                               state = EXCLUDED.state, active = EXCLUDED.active`,
			id, name, strings.TrimSpace(b.City), strings.TrimSpace(b.State), active)
	case "shifts":
		if b.StartTime == "" || b.EndTime == "" {
			writeErr(w, http.StatusBadRequest, "a shift needs a start and an end time")
			return
		}
		id = defaultTo(b.ID, "shift_"+newUID())
		_, err = s.db.Exec(r.Context(), `
			INSERT INTO hr_shifts (id, name, start_time, end_time, active) VALUES ($1,$2,$3,$4,$5)
			ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, start_time = EXCLUDED.start_time,
			                               end_time = EXCLUDED.end_time, active = EXCLUDED.active`,
			id, name, b.StartTime, b.EndTime, active)
	default:
		writeErr(w, http.StatusNotFound, "unknown configuration type")
		return
	}
	if err != nil {
		log.Printf("hr: config save failed for %s: %v", kind, err)
		writeErr(w, http.StatusInternalServerError, "could not save that")
		return
	}

	s.auditHR(r.Context(), u, "HR configuration changed", kind+" "+id)
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "saved": true})
}

// ---------- rota ----------

// PUT /api/hr/schedules
//
// Sets one employee's rota across a date range in a single call, because a rota is published a week
// at a time and not a day at a time. Weekends can be skipped, which is the difference between "this
// person works Monday to Friday" and "this person works seven days".
func (s *Server) handleScheduleSave(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var b struct {
		UserID      string `json:"userId"`
		From        string `json:"from"`
		To          string `json:"to"`
		ShiftID     string `json:"shiftId"`
		StartTime   string `json:"startTime"`
		EndTime     string `json:"endTime"`
		IsDayOff    bool   `json:"isDayOff"`
		SkipWeekend bool   `json:"skipWeekend"`
		Note        string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	from, okFrom := parseDate(b.From)
	to, okTo := parseDate(b.To)
	if !okFrom || !okTo {
		writeErr(w, http.StatusBadRequest, "from and to must be YYYY-MM-DD")
		return
	}
	if to.Before(from) {
		writeErr(w, http.StatusBadRequest, "the end of the range is before its start")
		return
	}
	// A rota is published, not backfilled indefinitely. The cap stops a mistyped year writing
	// thousands of rows.
	if to.Sub(from) > 370*24*time.Hour {
		writeErr(w, http.StatusBadRequest, "a rota range cannot be longer than a year")
		return
	}
	var employeeExists int
	_ = s.db.QueryRow(r.Context(), `SELECT count(*) FROM employees WHERE user_id = $1`, b.UserID).
		Scan(&employeeExists)
	if employeeExists == 0 {
		writeErr(w, http.StatusNotFound, errNotAnEmployee.Error())
		return
	}

	// The shift supplies the times unless they were given explicitly, so a caller normally picks a
	// shift and nothing else.
	start, end := nullTime(b.StartTime), nullTime(b.EndTime)
	if b.ShiftID != "" && start == nil && end == nil && !b.IsDayOff {
		var sTime, eTime string
		if err := s.db.QueryRow(r.Context(),
			`SELECT to_char(start_time,'HH24:MI'), to_char(end_time,'HH24:MI') FROM hr_shifts WHERE id = $1`,
			b.ShiftID).Scan(&sTime, &eTime); err != nil {
			writeErr(w, http.StatusBadRequest, "that shift does not exist")
			return
		}
		start, end = &sTime, &eTime
	}
	if b.IsDayOff {
		start, end = nil, nil
	}

	written := 0
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		if b.SkipWeekend && (d.Weekday() == time.Saturday || d.Weekday() == time.Sunday) {
			continue
		}
		if _, err := s.db.Exec(r.Context(), `
			INSERT INTO employee_schedules (id, user_id, work_date, shift_id, start_time, end_time,
			                                is_day_off, note, created_by)
			VALUES ($1,$2,$3,$4,$5::time,$6::time,$7,$8,$9)
			ON CONFLICT (user_id, work_date) DO UPDATE
			  SET shift_id = EXCLUDED.shift_id, start_time = EXCLUDED.start_time,
			      end_time = EXCLUDED.end_time, is_day_off = EXCLUDED.is_day_off,
			      note = EXCLUDED.note`,
			"SCH"+newUID(), b.UserID, d, nullable(b.ShiftID), start, end,
			b.IsDayOff, clip(b.Note, 200), u.Name); err != nil {
			log.Printf("hr: schedule write failed: %v", err)
			writeErr(w, http.StatusInternalServerError, "could not save the rota")
			return
		}
		written++
	}

	s.auditHR(r.Context(), u, "Rota updated",
		fmt.Sprintf("%s, %d day(s) from %s to %s", b.UserID, written, b.From, b.To))
	writeJSON(w, http.StatusOK, map[string]any{"saved": true, "days": written})
}

// ---------- attendance ----------

// PUT /api/hr/attendance
//
// One employee, one date. The status must be a configured attendance value, so a typo cannot invent
// a status that then fails to match any filter and quietly disappears from every count.
func (s *Server) handleAttendanceSave(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var b struct {
		UserID      string `json:"userId"`
		Date        string `json:"date"`
		Status      string `json:"status"`
		ClockIn     string `json:"clockIn"`
		ClockOut    string `json:"clockOut"`
		MinutesLate *int   `json:"minutesLate"`
		Note        string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	day, ok := parseDate(b.Date)
	if !ok {
		writeErr(w, http.StatusBadRequest, "the date must be YYYY-MM-DD")
		return
	}
	// Attendance cannot be recorded for the future. It is a record of what happened, and a future
	// entry is either a mistake or a rota entry in the wrong place.
	if day.After(time.Now().AddDate(0, 0, 1)) {
		writeErr(w, http.StatusBadRequest,
			"attendance cannot be recorded for a future date - use the rota instead")
		return
	}

	var n int
	_ = s.db.QueryRow(r.Context(),
		`SELECT count(*) FROM workflow_statuses WHERE domain = 'hr_attendance' AND code = $1 AND active`,
		b.Status).Scan(&n)
	if n == 0 {
		writeErr(w, http.StatusBadRequest, "that is not one of the configured attendance statuses")
		return
	}

	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO employee_attendance (id, user_id, work_date, status, clock_in, clock_out,
		                                 minutes_late, note, recorded_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (user_id, work_date) DO UPDATE
		  SET status = EXCLUDED.status, clock_in = EXCLUDED.clock_in, clock_out = EXCLUDED.clock_out,
		      minutes_late = EXCLUDED.minutes_late, note = EXCLUDED.note,
		      recorded_by = EXCLUDED.recorded_by`,
		"ATT"+newUID(), b.UserID, day, b.Status,
		nullTimestamp(b.ClockIn), nullTimestamp(b.ClockOut), b.MinutesLate,
		clip(b.Note, 300), u.Name); err != nil {
		log.Printf("hr: attendance write failed: %v", err)
		writeErr(w, http.StatusInternalServerError, "could not record attendance")
		return
	}

	// The STATUS is audited, not the note: a note on an attendance record can say why somebody was
	// absent, and that can be a medical matter.
	s.auditHR(r.Context(), u, "Attendance recorded",
		fmt.Sprintf("%s on %s: %s", b.UserID, b.Date, b.Status))
	writeJSON(w, http.StatusOK, map[string]any{"saved": true})
}

// ---------- leave ----------

// POST /api/hr/leave - raise a request.
func (s *Server) handleLeaveCreate(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	var b struct {
		UserID    string   `json:"userId"`
		LeaveType string   `json:"leaveType"`
		Start     string   `json:"start"`
		End       string   `json:"end"`
		Hours     *float64 `json:"hours"`
		Reason    string   `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	start, okS := parseDate(b.Start)
	end, okE := parseDate(b.End)
	if !okS || !okE {
		writeErr(w, http.StatusBadRequest, "the dates must be YYYY-MM-DD")
		return
	}
	if end.Before(start) {
		writeErr(w, http.StatusBadRequest, "the end date is before the start date")
		return
	}
	var n int
	_ = s.db.QueryRow(r.Context(),
		`SELECT count(*) FROM workflow_statuses WHERE domain = 'hr_leave_type' AND code = $1 AND active`,
		b.LeaveType).Scan(&n)
	if n == 0 {
		writeErr(w, http.StatusBadRequest, "that is not one of the configured leave types")
		return
	}

	// An overlapping APPROVED request is refused: two approved leaves covering the same day make
	// "who is off" ambiguous, and the derived status would depend on which row the join happened to
	// pick.
	var clash int
	_ = s.db.QueryRow(r.Context(), `
		SELECT count(*) FROM pto_requests
		 WHERE user_id = $1 AND status = 'APPROVED' AND start_date <= $3 AND end_date >= $2`,
		b.UserID, start, end).Scan(&clash)
	if clash > 0 {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": "that overlaps leave already approved for this employee",
		})
		return
	}

	id := "PTO" + newUID()
	if _, err := s.db.Exec(r.Context(), `
		INSERT INTO pto_requests (id, user_id, leave_type, status, start_date, end_date, hours, reason)
		VALUES ($1,$2,$3,'PENDING',$4,$5,$6,$7)`,
		id, b.UserID, b.LeaveType, start, end, b.Hours, clip(b.Reason, 500)); err != nil {
		log.Printf("hr: leave insert failed: %v", err)
		writeErr(w, http.StatusInternalServerError, "could not raise the request")
		return
	}

	// The reason is stored but never audited - see the note in hr.go about why the workforce screen
	// does not show it either.
	s.auditHR(r.Context(), u, "Leave requested",
		fmt.Sprintf("%s, %s %s to %s", b.UserID, b.LeaveType, b.Start, b.End))
	writeJSON(w, http.StatusOK, map[string]any{"id": id})
}

// POST /api/hr/leave/{id}/decision - approve or refuse.
func (s *Server) handleLeaveDecision(w http.ResponseWriter, r *http.Request) {
	u := userFrom(r.Context())
	id := r.PathValue("id")
	var b struct {
		Decision string `json:"decision"` // APPROVED | DENIED | CANCELLED
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, http.StatusBadRequest, "malformed request")
		return
	}
	switch b.Decision {
	case "APPROVED", "DENIED", "CANCELLED":
	default:
		writeErr(w, http.StatusBadRequest, "the decision must be APPROVED, DENIED or CANCELLED")
		return
	}

	var current, userID string
	var start, end time.Time
	if err := s.db.QueryRow(r.Context(),
		`SELECT status, user_id, start_date, end_date FROM pto_requests WHERE id = $1`, id).
		Scan(&current, &userID, &start, &end); err != nil {
		writeErr(w, http.StatusNotFound, "leave request not found")
		return
	}

	// A pending request can be decided. An approved one can be cancelled. A request that has
	// already been refused or cancelled is final - it is superseded by a new request, not edited,
	// so the record of what was decided and when survives.
	allowed := (current == "PENDING" && (b.Decision == "APPROVED" || b.Decision == "DENIED")) ||
		(current == "APPROVED" && b.Decision == "CANCELLED")
	if !allowed {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": fmt.Sprintf(
				"this request is %s and cannot be changed to %s. Raise a new request instead.",
				strings.ToLower(current), strings.ToLower(b.Decision)),
		})
		return
	}

	if b.Decision == "APPROVED" {
		var clash int
		_ = s.db.QueryRow(r.Context(), `
			SELECT count(*) FROM pto_requests
			 WHERE user_id = $1 AND status = 'APPROVED' AND id <> $2
			   AND start_date <= $4 AND end_date >= $3`, userID, id, start, end).Scan(&clash)
		if clash > 0 {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": "approving this would overlap leave already approved for this employee",
			})
			return
		}
	}

	if _, err := s.db.Exec(r.Context(),
		`UPDATE pto_requests SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1`,
		id, b.Decision, u.Name); err != nil {
		log.Printf("hr: leave decision failed: %v", err)
		writeErr(w, http.StatusInternalServerError, "could not record the decision")
		return
	}

	s.auditHR(r.Context(), u, "Leave "+strings.ToLower(b.Decision), fmt.Sprintf("%s, request %s", userID, id))
	writeJSON(w, http.StatusOK, map[string]any{"status": b.Decision})
}

// GET /api/hr/leave?status=PENDING - the approvals queue.
func (s *Server) handleLeaveList(w http.ResponseWriter, r *http.Request) {
	status := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("status")))
	where, args := "", []any{}
	if status != "" {
		args = append(args, status)
		where = " WHERE p.status = $1"
	}
	rows, err := s.db.Query(r.Context(), `
		SELECT p.id, p.user_id, u.name, coalesce(d.name,''), p.leave_type, p.status,
		       p.start_date, p.end_date, p.hours, p.decided_by, p.decided_at, p.requested_at
		  FROM pto_requests p
		  JOIN users u ON u.id = p.user_id
		  LEFT JOIN employees e ON e.user_id = p.user_id
		  LEFT JOIN hr_departments d ON d.id = e.department_id`+where+`
		 ORDER BY p.status = 'PENDING' DESC, p.start_date DESC LIMIT 200`, args...)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not read the leave requests")
		return
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var id, uid, name, dept, kind, st, decidedBy string
		var start, end time.Time
		var hours *float64
		var decidedAt, requestedAt *time.Time
		if rows.Scan(&id, &uid, &name, &dept, &kind, &st, &start, &end, &hours,
			&decidedBy, &decidedAt, &requestedAt) != nil {
			continue
		}
		row := map[string]any{
			"id": id, "userId": uid, "name": name, "department": dept,
			"leaveType": kind, "status": st,
			"start": start.Format("2006-01-02"), "end": end.Format("2006-01-02"),
			"days":        int(end.Sub(start).Hours()/24) + 1,
			"decidedBy":   decidedBy,
			"decidedAt":   tsOrEmpty(decidedAt),
			"requestedAt": tsOrEmpty(requestedAt),
		}
		if hours != nil {
			row["hours"] = *hours
		}
		// The reason is deliberately absent from this list, as it is everywhere else.
		out = append(out, row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": out})
}

// ---------- small helpers ----------

func defaultTo(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

func nullDate(s string) any {
	if d, ok := parseDate(s); ok {
		return d
	}
	return nil
}

func nullTime(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	v := strings.TrimSpace(s)
	return &v
}

func nullTimestamp(s string) any {
	v := strings.TrimSpace(s)
	if v == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04", "2006-01-02 15:04"} {
		if t, err := time.Parse(layout, v); err == nil {
			return t
		}
	}
	return nil
}
