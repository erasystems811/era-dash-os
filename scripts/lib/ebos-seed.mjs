// Turns the workstation's captured business config into the SQL appended to
// a new EBOS client's init.sql -- this is what makes "click through the
// workstation" produce a real, seeded business instead of an empty
// template. The owner password is hashed with pgcrypto's crypt(), the same
// function ebos-templates/dashboard/lib/auth.js's bcryptjs verifies against
// -- both implement the same bcrypt spec, confirmed compatible.

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

// Nullable text[] columns (choices, examples) -- absent means "no rule",
// stored as null.
function sqlArrayOrNull(values) {
  if (!values || !values.length) return 'null';
  return `array[${values.map(sqlString).join(', ')}]::text[]`;
}

// bot_state.allowed_next is `not null default '{}'` -- absent means "goes
// nowhere", stored as an empty array, never null.
function sqlArrayNotNull(values) {
  if (!values || !values.length) return 'array[]::text[]';
  return `array[${values.map(sqlString).join(', ')}]::text[]`;
}

export function buildEbosSeedSql({ business, owner, ownerPassword, catalogue, botFields, botStates, knowledgeBase }) {
  const lines = [];

  lines.push(
    `insert into business (name, type, address, phone_number, delivery_enabled, whatsapp_connection, handover_number, bank_name, bank_account_number, bank_account_name, logo_data_url, brand_color)
     values (${sqlString(business.name)}, ${sqlString(business.type)}, ${sqlString(business.address)}, ${sqlString(business.phone_number)}, ${sqlBool(business.delivery_enabled)}, ${sqlString(business.whatsapp_connection)}, ${sqlString(business.handover_number)}, ${sqlString(business.bank_name)}, ${sqlString(business.bank_account_number)}, ${sqlString(business.bank_account_name)}, ${sqlString(business.logo_data_url)}, ${sqlString(business.brand_color) === 'null' ? "'#111827'" : sqlString(business.brand_color)});`
  );

  lines.push(
    `insert into staff (name, email, password_hash, role)
     values (${sqlString(owner.name)}, ${sqlString(String(owner.email).trim().toLowerCase())}, crypt(${sqlString(ownerPassword)}, gen_salt('bf')), 'owner');`
  );

  for (const item of catalogue || []) {
    lines.push(
      `insert into product (name, description, price, availability_type, duration_minutes)
       values (${sqlString(item.name)}, ${sqlString(item.description)}, ${sqlNumber(item.price)}, ${sqlString(item.availability_type || 'stock')}, ${sqlNumber(item.duration_minutes)});`
    );
  }

  for (const field of botFields || []) {
    lines.push(
      `insert into bot_field (key, label, question, type, choices, examples, required_for_state)
       values (${sqlString(field.key)}, ${sqlString(field.label)}, ${sqlString(field.question)}, ${sqlString(field.type || 'text')}, ${sqlArrayOrNull(field.choices)}, ${sqlArrayOrNull(field.examples)}, ${field.required_for_state ? sqlString(field.required_for_state) : 'null'});`
    );
  }

  // Upsert, not insert -- schema.sql already seeds the 11 default states
  // unconditionally, so this overrides them with whatever the workstation's
  // conversation-flow canvas ended up with (identical if untouched).
  for (const state of botStates || []) {
    lines.push(
      `insert into bot_state (key, label, position_x, position_y, allowed_next)
       values (${sqlString(state.key)}, ${sqlString(state.label)}, ${sqlNumber(state.position_x) || 0}, ${sqlNumber(state.position_y) || 0}, ${sqlArrayNotNull(state.allowed_next)})
       on conflict (key) do update set label = excluded.label, position_x = excluded.position_x, position_y = excluded.position_y, allowed_next = excluded.allowed_next;`
    );
  }

  for (const kb of knowledgeBase || []) {
    lines.push(`insert into knowledge_base (question, answer) values (${sqlString(kb.question)}, ${sqlString(kb.answer)});`);
  }

  return lines.join('\n');
}
