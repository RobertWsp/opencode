import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

export const AccountUsageTable = sqliteTable("account_usage", {
  id: text().primaryKey().notNull(),
  provider_id: text().notNull(),
  account_index: integer().notNull(),
  request_count: integer().default(0).notNull(),
  token_count: integer().default(0).notNull(),
  last_used_at: integer(),
  cooldown_until: integer(),
  disabled: integer().default(0).notNull(),
  switch_count: integer().default(0).notNull(),
  time_created: integer()
    .notNull()
    .$default(() => Date.now()),
  time_updated: integer()
    .notNull()
    .$onUpdate(() => Date.now()),
})
