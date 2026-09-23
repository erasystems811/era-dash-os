-- Chidera, 2026-09-20: "i think this detailed option should not be a text
-- thing they should pick from dropdown and still be able to write extra
-- note(optional), so it can be faster" -- product_question was free-text
-- only (the customer typed a real answer, same shape the bot's own AI
-- extraction already accepted in chat). Nullable -- a question with no
-- options defined keeps the exact same free-text input on the web menu
-- page; only a question a business has actually given real choices to
-- gets the faster dropdown-plus-optional-note UI.
alter table product_question add column if not exists options text[];
