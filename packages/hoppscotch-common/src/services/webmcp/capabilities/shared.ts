export const safeTarget = (endpoint: string) => {
  if (endpoint.includes("<<")) return "templated endpoint"
  try {
    const trimmed = endpoint.trim()
    const domain = trimmed.split(/[/:#?]+/)[0]
    const normalized = /^(https?|wss?):\/\//.test(trimmed)
      ? trimmed
      : domain === "localhost" || /([0-9]+\.)*[0-9]/.test(domain)
        ? `http://${trimmed}`
        : `https://${trimmed}`
    const url = new URL(normalized)
    return `${url.origin}${url.pathname}`.slice(0, 512)
  } catch {
    return "invalid endpoint"
  }
}
