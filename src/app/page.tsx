/**
 * Placeholder shell. The chat surface is task group 8 and the login gate is task group 2 —
 * neither is built yet, and task group 2 is blocked on spike 1.4.
 */
export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 p-6">
      <h1 className="text-2xl font-semibold">Stelic Assistant</h1>
      <p className="text-sm opacity-70">
        Log your time by chatting. Not wired up yet — foundations only.
      </p>
    </main>
  )
}
