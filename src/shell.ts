export function shQuote(arg: string): string {
  // Safe for bash/sh. We don't try to be clever: always quote when needed.
  if (/^[A-Za-z0-9_/:=.,+@%-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\"'\"'`)}'`;
}

export function shJoin(args: string[]): string {
  return args.map(shQuote).join(" ");
}

