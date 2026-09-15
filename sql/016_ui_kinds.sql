-- The screen layer: buttons / steps / tabs a person clicks (UI_ACTION) and how screens lead to each other.
alter type ckg.entity_kind_t add value if not exists 'UI_ACTION';
alter type ckg.edge_kind_t add value if not exists 'NAVIGATES_TO';
