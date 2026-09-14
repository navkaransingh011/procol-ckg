-- 013: a document shipped WITH a commit or PR (PRD, design note) is linked to exactly the code that commit
-- changed -- by diff, not by guessing identifiers. DESCRIBES: DOCUMENT -> FILE/SYMBOL/HANDLER changed in that commit.
set search_path = ckg, public;
alter type edge_kind_t add value if not exists 'DESCRIBES';
