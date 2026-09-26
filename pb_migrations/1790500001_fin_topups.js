/// <reference path="../pb_data/types.d.ts" />
// E-wallet top-ups: a top-up is a balance that purchases (with receipts) are
// accounted against. Also records whose account a transaction came from.
migrate((app) => {
  const tx = app.findCollectionByNameOrId("fin_transactions")
  const kind = tx.fields.getByName("kind")
  if (!kind.values.includes("topup")) kind.values = [...kind.values, "topup"]
  if (!tx.fields.getByName("parent")) {
    tx.fields.add(new RelationField({ name: "parent", collectionId: tx.id, maxSelect: 1, cascadeDelete: false }))
  }
  if (!tx.fields.getByName("wallet")) tx.fields.add(new TextField({ name: "wallet", max: 40 }))
  if (!tx.fields.getByName("holder")) tx.fields.add(new TextField({ name: "holder", max: 100 }))
  tx.addIndex("idx_fin_tx_parent", false, "parent", "")
  app.save(tx)
}, (app) => {
  const tx = app.findCollectionByNameOrId("fin_transactions")
  tx.removeIndex("idx_fin_tx_parent")
  for (const f of ["parent", "wallet", "holder"]) tx.fields.removeByName(f)
  const kind = tx.fields.getByName("kind")
  kind.values = kind.values.filter((v) => v !== "topup")
  app.save(tx)
})
