/// <reference path="../pb_data/types.d.ts" />
// fin_reports also caches short AI notes (kind "note", key "<report>:<date>").
migrate((app) => {
  const c = app.findCollectionByNameOrId("fin_reports")
  const kind = c.fields.getByName("kind")
  if (!kind.values.includes("note")) kind.values = [...kind.values, "note"]
  c.fields.getByName("key").max = 80
  app.save(c)
}, (app) => {
  const c = app.findCollectionByNameOrId("fin_reports")
  const kind = c.fields.getByName("kind")
  kind.values = kind.values.filter((v) => v !== "note")
  app.save(c)
})
