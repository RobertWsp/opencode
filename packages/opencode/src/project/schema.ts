// Minimal stub for ProjectID that doesn't depend on Effect schema.
// Upstream's full version uses Effect.Schema brands — we just need the `global`
// constant and a type alias for the places cherry-picked patches reference it.
export type ProjectID = string & { readonly __brand: "ProjectID" }

export const ProjectID = {
  global: "global" as ProjectID,
}
