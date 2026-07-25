/**
 * Staying inside the remit (task 7.5, CHAT-13).
 *
 * The bot logs time. It does not answer questions about rates, budgets, invoices, approvals
 * or administration — and the point is not only to decline politely. It is that **no code
 * path in this app fetches any of it**. There is no rate lookup, no budget read, no approval
 * call. That absence is the real guarantee; this guard is the courteous front door on it, so
 * someone who asks gets an answer rather than a confused attempt to log "my rate" as a
 * project.
 *
 * ## Why a keyword list alone would be wrong
 *
 * "6h on Clayco for the budget review" is a perfectly ordinary time entry. Refusing it
 * because it contains the word *budget* would block real work every day — and blocking a log
 * is a worse failure than answering a question we would rather not answer, because the log is
 * the thing the app exists for.
 *
 * So the test is two-part: a sensitive topic **and** the shape of a question or an
 * instruction about it. A message that states a duration is a timesheet message and is never
 * refused, whatever words it contains.
 */

export type ScopeVerdict =
  { inScope: true } | { inScope: false; topic: OutOfScopeTopic; reply: string }

export type OutOfScopeTopic = 'rate' | 'budget' | 'invoice' | 'approval' | 'admin'

/**
 * A duration in any of the forms the hours parser accepts.
 *
 * Its presence is taken as proof that the message is about logging time. Deliberately loose:
 * a false positive here means a question gets through to the model, which can still only
 * answer with `reply_only` and cannot reach any of the refused data. A false *negative* means
 * a real entry is refused, which is the failure worth avoiding.
 */
const DURATION =
  /(\b\d+([.,:]\d+)?\s*(h\b|hr|hour|m\b|min)|\b\d+\s*h\s*\d+|\bhalf (a )?day\b|\ball day\b|\bfull day\b)/i

const TOPICS: { topic: OutOfScopeTopic; pattern: RegExp }[] = [
  {
    topic: 'rate',
    pattern: /\b(rate|rates|hourly rate|bill rate|charge[- ]?out|pay)\b/i,
  },
  {
    topic: 'budget',
    pattern: /\b(budget|budgets|burn[- ]?rate|remaining hours|over[- ]?run)\b/i,
  },
  {
    topic: 'invoice',
    pattern: /\b(invoice|invoices|invoiced|billing run|bill(ed)? amount|revenue)\b/i,
  },
  {
    topic: 'approval',
    pattern: /\b(approve|approval|approved|reject|sign[- ]?off|timesheet approval)\b/i,
  },
  {
    topic: 'admin',
    pattern:
      /\b(add (a )?user|remove (a )?user|deactivate|permissions?|admin(istration)?|create (a )?project|delete (a )?project|change (the )?portal)\b/i,
  },
]

/**
 * The shape of a question or an instruction.
 *
 * "what's my rate", "how much budget is left", "show me the invoice", "approve my timesheet",
 * "can you add a user". A statement that merely contains a topic word is not this.
 */
const ASKING =
  /(\?|^\s*(what|what's|whats|how|how's|hows|when|who|which|why|can|could|would|do|does|is|are|show|tell|give|list|get|find|set|change|make|add|remove|approve|reject|delete|create|update)\b)/i

const REPLIES: Record<OutOfScopeTopic, string> = {
  rate: "I don't have anything to do with rates — I only log time. Rates live in Zoho.",
  budget:
    "I can't see budgets, only the hours you log. Your PM or Zoho Projects can tell you where a project stands.",
  invoice: "Invoicing isn't something I touch. I only log time into Zoho Projects.",
  approval:
    "I can't approve or reject anything — I only log time. Approvals happen in Zoho Projects.",
  admin:
    "I can't change projects, users or settings. I only log time; an admin can do that in Zoho.",
}

const CAPABILITY =
  ' Tell me what you worked on and I’ll log it — for example, "8h on Clayco yesterday, structural review". I can also show you your week or undo something I logged today.'

/**
 * Should this message be refused before it reaches the model?
 *
 * Checked **before** the gateway call, so an out-of-scope question costs nothing and the
 * refusal is the app's own words rather than whatever the model decides to say.
 */
export function checkScope(message: string): ScopeVerdict {
  const text = message.trim()
  if (!text) return { inScope: true }

  // A stated duration means this is a time entry. Nothing after this point can refuse it.
  if (DURATION.test(text)) return { inScope: true }
  if (!ASKING.test(text)) return { inScope: true }

  for (const { topic, pattern } of TOPICS) {
    if (pattern.test(text)) {
      return { inScope: false, topic, reply: REPLIES[topic] + CAPABILITY }
    }
  }

  return { inScope: true }
}
