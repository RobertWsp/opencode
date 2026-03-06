import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import { Timestamps } from "@/storage/schema.sql"

export const ResourceUsageTable = sqliteTable(
  "resource_usage",
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    resource_type: text().notNull(),
    resource_name: text().notNull(),
    call_count: integer()
      .notNull()
      .$default(() => 0),
    total_latency_ms: integer()
      .notNull()
      .$default(() => 0),
    last_used_at: integer(),
    date: text(),
    ...Timestamps,
  },
  (table) => [
    index("resource_usage_project_id_idx").on(table.project_id),
    index("resource_usage_resource_name_idx").on(table.resource_name),
    index("resource_usage_date_idx").on(table.date),
  ],
)
