import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { GridMeta, SurveyFeature, SurveyStats } from "../lib/types";

/** Satu survei = satu kali pengambilan elevasi untuk sekumpulan fitur (garis/poligon/titik). */
export const surveys = pgTable("surveys", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  spacingM: doublePrecision("spacing_m").notNull(),
  corridorM: doublePrecision("corridor_m").notNull().default(0),
  zone: integer("zone").notNull(),
  south: boolean("south").notNull().default(false),
  epsg: text("epsg").notNull(),
  features: jsonb("features").$type<SurveyFeature[]>().notNull(),
  grid: jsonb("grid").$type<GridMeta | null>(),
  stats: jsonb("stats").$type<SurveyStats>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Titik elevasi (grid, profil garis, batas, simpul, titik) dengan koordinat lat/lon dan UTM. */
export const elevationPoints = pgTable(
  "elevation_points",
  {
    id: serial("id").primaryKey(),
    surveyId: integer("survey_id")
      .notNull()
      .references(() => surveys.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    feature: text("feature").notNull(),
    col: integer("col"),
    row: integer("row"),
    distance: doublePrecision("distance"),
    lat: doublePrecision("lat").notNull(),
    lon: doublePrecision("lon").notNull(),
    easting: doublePrecision("easting").notNull(),
    northing: doublePrecision("northing").notNull(),
    elevation: doublePrecision("elevation"),
  },
  (t) => [index("elevation_points_survey_seq_idx").on(t.surveyId, t.seq)],
);

export type SurveyRow = typeof surveys.$inferSelect;
export type ElevationPointRow = typeof elevationPoints.$inferSelect;
