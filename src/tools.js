// Read-only built-in tools. Caller controls network access through runAgent({ allowNetwork }).
// Never evaluate model-produced JavaScript or trust tool arguments without validation.

export function calculate(expression) {
  if (typeof expression !== "string" || expression.length > 80 || !/^[\d.+\-*/()\s]+$/.test(expression)) {
    throw new Error("Only short arithmetic expressions are allowed");
  }
  const tokens = expression.match(/\d+(?:\.\d+)?|\.\d+|[()+*/-]/g) ?? [];
  if (tokens.join("") !== expression.replace(/\s/g, "")) throw new Error("Invalid arithmetic expression");
  let pos = 0;
  function atom(depth) {
    if (depth > 32) throw new Error("Expression is too deeply nested");
    const token = tokens[pos++];
    if (token === "-" || token === "+") return (token === "-" ? -1 : 1) * atom(depth + 1);
    if (token === "(") {
      const value = sum(depth + 1);
      if (tokens[pos++] !== ")") throw new Error("Unclosed parenthesis");
      return value;
    }
    if (!token || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(token)) throw new Error("Expected a number");
    return Number(token);
  }
  function product(depth) {
    let value = atom(depth);
    while (tokens[pos] === "*" || tokens[pos] === "/") {
      const op = tokens[pos++];
      const rhs = atom(depth);
      if (op === "/" && rhs === 0) throw new Error("Division by zero");
      value = op === "*" ? value * rhs : value / rhs;
    }
    return value;
  }
  function sum(depth) {
    let value = product(depth);
    while (tokens[pos] === "+" || tokens[pos] === "-") {
      const op = tokens[pos++];
      value += (op === "+" ? 1 : -1) * product(depth);
    }
    return value;
  }
  const result = sum(0);
  if (pos !== tokens.length || !Number.isFinite(result) || Math.abs(result) > 1e12) throw new Error("Invalid arithmetic result");
  return result;
}

export function defaultTools({ fetch: request = globalThis.fetch } = {}) {
  return [
    {
      name: "get_datetime",
      description: "Read the device's current date and time in UTC. Use for questions about today or the current time.",
      parameters: { type: "object", properties: {}, required: [] },
      network: false,
      run: async () => ({ datetime: new Date().toISOString() }),
    },
    {
      name: "calculate",
      description: "Calculate an arithmetic expression using +, -, *, /, and parentheses.",
      parameters: { type: "object", properties: { expression: { type: "string", description: "Arithmetic expression, e.g. (2+3)*7" } }, required: ["expression"] },
      network: false,
      run: async ({ expression }) => ({ result: calculate(expression) }),
    },
    {
      name: "wiki_search",
      description: "Search Wikipedia for public facts. Sends the search query over the internet.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Words to search for" } }, required: ["query"] },
      network: true,
      async run({ query }, { signal }) {
        const url = new URL("https://en.wikipedia.org/w/api.php");
        url.search = new URLSearchParams({ action: "query", list: "search", srsearch: query, srlimit: "3", format: "json", origin: "*" }).toString();
        const res = await request(url.href, { signal });
        if (!res.ok) throw new Error(`Wikipedia returned HTTP ${res.status}`);
        const data = await res.json();
        return { results: (data.query?.search ?? []).slice(0, 3).map((p) => ({
          title: String(p.title).slice(0, 120),
          snippet: String(p.snippet).replace(/<[^>]*>/g, "").slice(0, 300),
        })) };
      },
    },
  ];
}
