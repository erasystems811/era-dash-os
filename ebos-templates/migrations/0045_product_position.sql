-- Chidera, 2026-09-16: "i dont think the ai properly organized the menu in
-- my catalogue, it only got category right, it scattered the rest... the
-- actual menu should be up as organized" -- root cause wasn't the AI
-- extraction (category was captured correctly), it was the Catalogue page
-- forcing everything alphabetical (both which category shows first, and
-- item order within a category), discarding the real menu's own layout.
-- A real menu is rarely alphabetical -- a "combos"/"chef's specials"
-- section usually belongs first regardless of its name, and items within
-- a section are ordered on purpose, not A-Z.
--
-- position preserves reading order instead: bulk-import assigns it in the
-- order items were found in the source text/photo(s), so both category
-- grouping order and item order within a category now follow the actual
-- menu. Backfill uses created_at so nothing already live gets reshuffled
-- by this migration itself.
alter table product add column if not exists position integer;

update product set position = sub.rn
from (select id, row_number() over (order by created_at asc) as rn from product) sub
where product.id = sub.id and product.position is null;
