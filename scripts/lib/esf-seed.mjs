// Turns the workstation's captured business config into the SQL appended to
// a new ESF client's init.sql -- same job as ebos-seed.mjs, for ESF's
// schema instead (business/staff/task/step/owner_user, not
// business/staff/product/bot_field/bot_state). The owner password is
// hashed with pgcrypto's crypt(), the same function
// esf-templates/dashboard/lib/auth.js's bcryptjs verifies against -- both
// implement the same bcrypt spec, confirmed compatible (same reasoning as
// ebos-seed.mjs).

function sqlString(value) {
  if (value === null || value === undefined || value === '') return 'null';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlBool(value) {
  return value ? 'true' : 'false';
}

function sqlNumber(value) {
  return value === null || value === undefined || value === '' ? 'null' : Number(value);
}

// sqlNumber() already turns a missing value into the STRING 'null', not
// JS null/undefined -- `sqlNumber(x) ?? fallback` looks like it defaults
// missing values but never actually does, since a non-empty string is
// never nullish (this shipped broken once, caught by a real PGlite smoke
// test, not by inspection). Use this instead of that pattern everywhere a
// numeric column needs a default the database's own column default
// shouldn't be relied on for (mid-VALUES-list columns can't be omitted).
function sqlNumberOr(value, fallback) {
  const n = sqlNumber(value);
  return n === 'null' ? fallback : n;
}

function sqlJsonb(value) {
  return `${sqlString(JSON.stringify(value || {}))}::jsonb`;
}

export function buildEsfSeedSql({ business, owner, ownerPassword, staff, tasks, alertRoutes }) {
  const lines = [];

  lines.push(
    `insert into business (name, timezone, lat, lng, radius_m, owner_phone)
     values (${sqlString(business.name)}, ${sqlString(business.timezone) === 'null' ? "'Africa/Lagos'" : sqlString(business.timezone)}, ${sqlNumber(business.lat)}, ${sqlNumber(business.lng)}, ${sqlNumberOr(business.radius_m, 200)}, ${sqlString(business.owner_phone)});`
  );

  lines.push(
    `insert into owner_user (email, password_hash, role, can_override)
     values (${sqlString(String(owner.email).trim().toLowerCase())}, crypt(${sqlString(ownerPassword)}, gen_salt('bf')), 'owner', true);`
  );

  // Maps a staff row's phone (unique within this deployment) to the id
  // assigned at insert time, so task/step seeding below can't rely on any
  // id the caller might have made up -- the database's own gen_random_uuid()
  // is the only source of truth for these ids.
  const staffPhoneToPlaceholder = new Map();
  for (const s of staff || []) {
    lines.push(
      `insert into staff (phone, name, role, shift_start, shift_end)
       values (${sqlString(s.phone)}, ${sqlString(s.name)}, ${sqlString(s.role)}, ${sqlString(s.shift_start)}, ${sqlString(s.shift_end)});`
    );
    staffPhoneToPlaceholder.set(s.phone, true);
  }

  for (const task of tasks || []) {
    // Postgres's WITH ... RETURNING inside a plain SQL script (no
    // procedural block) can't hand a generated id to the next statement, so
    // each task's steps are inserted via a subselect on a value this same
    // script just inserted (name is not unique, so scope the subselect to
    // "the task with this name that has no steps yet" would be fragile with
    // duplicate names -- instead each task insert is immediately followed by
    // its own steps in one CTE, which the SQL below builds directly).
    const stepValues = (task.steps || [])
      .map(
        (s) =>
          `(${s.seq}, ${sqlString(s.instruction)}, ${sqlString(s.proof_type)}, ${sqlJsonb(s.proof_config)}, ${sqlString(s.on_problem) === 'null' ? "'continue'" : sqlString(s.on_problem)}, ${sqlBool(s.optional)}, ${s.requires_prev === false ? 'false' : 'true'}, ${sqlString(s.clock_action) === 'null' ? "'none'" : sqlString(s.clock_action)})`
      )
      .join(',\n       ');

    // assigned_phone (optional) pins this task to one specific staff
    // member, same as the dashboard's task builder's "Assign to" picker
    // (routes/tasks.js) -- resolved by a subselect against the phone this
    // same seed just inserted above, since there's no other way to name a
    // not-yet-existing row's id from within one plain SQL script (no
    // procedural block to hand a generated id forward otherwise).
    const staffIdExpr = task.assigned_phone ? `(select id from staff where phone = ${sqlString(task.assigned_phone)})` : 'null';

    lines.push(
      `with new_task as (
         insert into task (name, staff_id, role, seq, days, available_from, due_by, mode)
         values (${sqlString(task.name)}, ${staffIdExpr}, ${sqlString(task.role)}, ${sqlNumberOr(task.seq, 0)}, ${sqlString(task.days)}, ${sqlString(task.available_from)}, ${sqlString(task.due_by)}, ${sqlString(task.mode) === 'null' ? "'chat'" : sqlString(task.mode)})
         returning id
       )
       insert into step (task_id, seq, instruction, proof_type, proof_config, on_problem, optional, requires_prev, clock_action)
       select new_task.id, v.seq, v.instruction, v.proof_type, v.proof_config, v.on_problem, v.optional, v.requires_prev, v.clock_action
       from new_task, (values
       ${stepValues || "(1, 'placeholder -- no steps configured', 'tap', '{}'::jsonb, 'continue', false, true, 'none')"}
       ) as v(seq, instruction, proof_type, proof_config, on_problem, optional, requires_prev, clock_action)
       ${stepValues ? '' : 'where false'};` // no real steps -- insert nothing rather than a placeholder row
    );
  }

  for (const route of alertRoutes || []) {
    lines.push(
      `insert into alert_route (event, channel, target, quiet_hours)
       values (${sqlString(route.event)}, ${sqlString(route.channel) === 'null' ? "'whatsapp'" : sqlString(route.channel)}, ${sqlString(route.target)}, ${sqlString(route.quiet_hours)});`
    );
  }

  return lines.join('\n');
}
