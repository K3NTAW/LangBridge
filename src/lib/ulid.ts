/**
 * Tiny ULID-shaped (Crockford Base32, 26 chars) generator.
 * The engine validates ULID parse on ids — keep this shape everywhere.
 */
export function ulidLite(): string {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const time = Date.now();
  const timeChars: string[] = [];
  let t = time;
  for (let i = 0; i < 10; i++) {
    timeChars.unshift(ALPHABET[t % 32] ?? "0");
    t = Math.floor(t / 32);
  }
  const rand = new Uint8Array(16);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(rand);
  } else {
    for (let i = 0; i < rand.length; i++) rand[i] = Math.floor(Math.random() * 256);
  }
  const randChars: string[] = [];
  for (let i = 0; i < 16; i++) randChars.push(ALPHABET[(rand[i] ?? 0) % 32] ?? "0");
  return timeChars.join("") + randChars.join("");
}
