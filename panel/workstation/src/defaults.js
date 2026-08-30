// Same 10-state map (+ cancelled) ebos-templates/schema.sql seeds by
// default -- the canvas starts here so a new business already has a
// working flow, not a blank page. Editing it here overrides the seed at
// build time (routes/workstation.js -> ebos-seed.mjs upserts on key).
export const DEFAULT_BOT_STATES = [
  { key: 'new_inquiry', label: 'New inquiry', position_x: 0, position_y: 0, allowed_next: ['understand_request', 'cancelled'] },
  { key: 'understand_request', label: 'Understand request', position_x: 220, position_y: 0, allowed_next: ['collect_info', 'cancelled'] },
  { key: 'collect_info', label: 'Collect information', position_x: 440, position_y: 0, allowed_next: ['check_availability', 'cancelled'] },
  { key: 'check_availability', label: 'Check availability', position_x: 660, position_y: 0, allowed_next: ['calculate_price', 'collect_info', 'cancelled'] },
  { key: 'calculate_price', label: 'Calculate price', position_x: 880, position_y: 0, allowed_next: ['confirm_order', 'cancelled'] },
  { key: 'confirm_order', label: 'Confirm order', position_x: 1100, position_y: 0, allowed_next: ['confirm_payment', 'collect_info', 'cancelled'] },
  { key: 'confirm_payment', label: 'Confirm payment', position_x: 1320, position_y: 0, allowed_next: ['payment_acceptance', 'cancelled'] },
  { key: 'payment_acceptance', label: 'Payment acceptance', position_x: 1540, position_y: 0, allowed_next: ['fulfilment'] },
  { key: 'fulfilment', label: 'Fulfilment', position_x: 1760, position_y: 0, allowed_next: ['completed'] },
  { key: 'completed', label: 'Completed', position_x: 1980, position_y: 0, allowed_next: [] },
  { key: 'cancelled', label: 'Cancelled', position_x: 660, position_y: 200, allowed_next: [] },
];

// Per business type defaults from the build schema's section 7 -- the
// starting point for the Train the bot tab once a type is picked. Editable
// afterward; picking a type only seeds these if the list is still empty,
// so it never silently overwrites something already customised.
export const DEFAULT_BOT_FIELDS = {
  restaurant: [
    { key: 'item', label: 'menu item', question: 'What would you like to order today?', type: 'choice', choices: [], examples: [], required_for_state: 'collect_info' },
    { key: 'quantity', label: 'quantity', question: 'How many would you like?', type: 'text', choices: [], examples: ['1', '2', '3'], required_for_state: 'collect_info' },
    { key: 'fulfilment_type', label: 'delivery or pickup', question: 'Would you like delivery or pickup?', type: 'choice', choices: ['delivery', 'pickup'], examples: [], required_for_state: 'collect_info' },
    { key: 'delivery_address', label: 'delivery address', question: 'What is the delivery address?', type: 'text', choices: [], examples: [], required_for_state: 'collect_info' },
  ],
  apartment: [
    { key: 'property', label: 'property', question: 'Which property would you like to book?', type: 'choice', choices: [], examples: [], required_for_state: 'collect_info' },
    { key: 'date', label: 'check-in date', question: 'What date would you like to check in?', type: 'date', choices: [], examples: [], required_for_state: 'collect_info' },
    { key: 'end_date', label: 'check-out date', question: 'What date would you like to check out?', type: 'date', choices: [], examples: [], required_for_state: 'collect_info' },
    { key: 'guest_count', label: 'number of guests', question: 'How many guests?', type: 'text', choices: [], examples: ['1', '2', '4'], required_for_state: 'collect_info' },
  ],
  car_rental: [
    { key: 'vehicle', label: 'vehicle', question: 'Which vehicle would you like to rent?', type: 'choice', choices: [], examples: [], required_for_state: 'collect_info' },
    { key: 'date', label: 'start date', question: 'What date would you like to start?', type: 'date', choices: [], examples: [], required_for_state: 'collect_info' },
    { key: 'end_date', label: 'end date', question: 'What date would you like to return the vehicle?', type: 'date', choices: [], examples: [], required_for_state: 'collect_info' },
  ],
  lashes_nails: [
    { key: 'service', label: 'service', question: 'Which service would you like to book?', type: 'choice', choices: [], examples: [], required_for_state: 'collect_info' },
    { key: 'date', label: 'date', question: 'What date works for you?', type: 'date', choices: [], examples: [], required_for_state: 'collect_info' },
    { key: 'time', label: 'time', question: 'What time works for you?', type: 'text', choices: [], examples: ['10am', '2:30pm'], required_for_state: 'collect_info' },
  ],
};

// Presets with built-in starter questions -- not a hard limit. Any business
// type can be typed in on the workstation ("Other, type your own"); it just
// starts with an empty question list instead of one of these.
export const BUSINESS_TYPES = [
  { value: 'restaurant', label: 'Restaurant and food' },
  { value: 'apartment', label: 'Shortlet and apartment' },
  { value: 'car_rental', label: 'Car rental' },
  { value: 'lashes_nails', label: 'Lashes, nails and installation' },
];

export const OTHER_TYPE = '__other__';
