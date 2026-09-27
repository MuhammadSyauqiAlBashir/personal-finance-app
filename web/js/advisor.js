import { api, armed, el, icon, markdown, toast } from "./lib.js?v=__VERSION__"

const SUGGESTIONS = [
  "How are we doing this month?",
  "Can we afford a Rp3.000.000 purchase this month?",
  "Where can we cut spending?",
  "How big should our emergency fund be?",
  "Plan for Lebaran and mudik costs",
]

export async function renderAdvisor(page) {
  const chat = el("div", { class: "chat" })
  const input = el("input", { placeholder: "Ask about your money…", maxlength: 2000, enterkeyhint: "send", "aria-label": "Message" })
  const send = el("button", { class: "btn primary", type: "submit", "aria-label": "Send" }, icon("send"))
  const form = el("form", {}, input, send)
  const bar = el("div", { class: "chat-input" }, form)
  const clear = el("button", { class: "link-btn small", type: "button", text: "Clear chat" })
  armed(clear, "Tap again to clear", async () => { await api("/advisor/chat", { method: "DELETE" }); renderAdvisor(page) })

  page.replaceChildren(el("div", { class: "topbar" },
    el("div", {}, el("h1", { text: "Advisor" }), el("div", { class: "sub", text: "Knows your wallets, goals and family profile." })), clear), chat)
  page.append(bar)
  document.querySelectorAll(".chat-input").forEach((n) => { if (n !== bar) n.remove() })
  // Remove the input bar when leaving this tab.
  const cleanup = () => { if (!location.hash.startsWith("#advisor")) { bar.remove(); window.removeEventListener("hashchange", cleanup) } }
  window.addEventListener("hashchange", cleanup)

  const add = (role, content) => {
    const node = el("div", { class: `msg ${role}` }, role === "assistant" ? markdown(content) : content)
    chat.append(node)
    return node
  }
  const { messages } = await api("/advisor/chat")
  if (!messages.length) {
    chat.append(el("div", { class: "card ai-card" }, el("div", { class: "ai-head" }, icon("spark"), "Hi! I'm your household finance advisor."),
      el("p", { class: "muted", text: "I see this month's wallets, spending, goals and your family profile. Ask me anything, or try one of these:" }),
      el("div", { class: "suggestions" }, SUGGESTIONS.map((s) => el("button", { class: "chip", type: "button", text: s, onclick: () => ask(s) })))))
  }
  for (const m of messages) add(m.role, m.content)
  window.scrollTo(0, document.body.scrollHeight)

  async function ask(text) {
    text = text.trim()
    if (!text) return
    input.value = ""
    add("user", text)
    const thinking = add("assistant", "_Thinking…_")
    thinking.classList.add("skeleton")
    window.scrollTo(0, document.body.scrollHeight)
    send.disabled = true
    try {
      const { answer } = await api("/advisor/chat", { method: "POST", json: { message: text } })
      thinking.replaceWith(add("assistant", answer))
    } catch (err) {
      thinking.remove()
      toast(err.message, "bad")
      input.value = text
    } finally {
      send.disabled = false
      window.scrollTo(0, document.body.scrollHeight)
    }
  }
  form.addEventListener("submit", (e) => { e.preventDefault(); ask(input.value) })
}
