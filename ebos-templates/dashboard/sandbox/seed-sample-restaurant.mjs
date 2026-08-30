import bcrypt from 'bcryptjs';
import { pool } from '../lib/db.js';

export async function seedSampleRestaurant() {
  const { rows: existing } = await pool.query('select id from business limit 1');
  if (existing.length) return;

  await pool.query(
    `insert into business (name, type, address, phone_number, delivery_enabled, whatsapp_connection, handover_number, bank_name, bank_account_number, bank_account_name)
     values ('Sample Restaurant Lagos', 'restaurant', '12 Admiralty Way, Lekki, Lagos', '2348010000000', true, 'api_only', '2348020000000', 'GTBank', '0123456789', 'Sample Restaurant Lagos')`
  );
  await pool.query(`insert into staff (name, email, password_hash, role) values ('Chidera Owner', 'owner@samplerestaurant.test', $1, 'owner')`, [
    await bcrypt.hash('testpass123', 10),
  ]);
  await pool.query(
    `insert into product (name, description, price, availability_type) values
     ('Jollof Rice and Chicken', 'Smoky party jollof with grilled chicken', 4500, 'stock'),
     ('Fried Rice and Beef', 'Fried rice with sauteed vegetables and beef', 4800, 'stock'),
     ('Suya Wrap', 'Spicy grilled beef wrap', 3000, 'stock')`
  );
  await pool.query(
    `insert into bot_field (key, label, question, type, choices, examples, required_for_state) values
     ('item', 'menu item', 'What would you like to order today?', 'choice', null, null, 'collect_info'),
     ('quantity', 'quantity', 'How many would you like?', 'text', null, array['1','2','3'], 'collect_info'),
     ('fulfilment_type', 'delivery or pickup', 'Would you like delivery or pickup?', 'choice', array['delivery','pickup'], null, 'collect_info'),
     ('delivery_address', 'delivery address', 'What is the delivery address?', 'text', null, null, 'collect_info')`
  );
  await pool.query(
    `insert into knowledge_base (question, answer, position) values
     ('What time do you open?', 'We are open every day from 9am to 10pm.', 1),
     ('Do you deliver?', 'Yes, we deliver across Lekki and Victoria Island.', 2)`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedSampleRestaurant().then(() => {
    console.log('Seeded.');
    process.exit(0);
  });
}
