/// <reference path="../pb_data/types.d.ts" />
// CLI: pocketbase fin-service <credentials-file>
// The file holds two lines: username, then password. Creates (or resets) the
// finance backend's service login: approved, role "service". That role is the
// only one the fin_* collection rules allow. Delete the file afterwards.
$app.rootCmd.addCommand(new Command({
  use: "fin-service",
  short: "create or reset the finance backend service login from a credentials file",
  run: (cmd, args) => {
    if (args.length !== 1) throw new Error("usage: fin-service <credentials-file>")

    const raw = $os.readFile(args[0])
    const text = typeof raw === "string" ? raw : String.fromCharCode(...raw)
    const [username, password] = text.split("\n").map((s) => s.trim())
    if (!/^[a-z0-9_]{3,32}$/.test(username || "")) throw new Error("bad username (a-z, 0-9, _; 3-32 chars)")
    if (!password || password.length < 32) throw new Error("service password must be at least 32 characters")

    const users = $app.findCollectionByNameOrId("users")
    let record
    try {
      record = $app.findFirstRecordByData(users, "username", username)
    } catch (_) {
      record = new Record(users)
      record.set("username", username)
      record.set("email", username + "@service.finance.local")
    }
    record.set("approved", true)
    record.set("role", "service")
    record.setPassword(password)
    $app.save(record)
    console.log("finance service login '" + username + "' saved")
  },
}))
