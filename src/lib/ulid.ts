import { ulid as ulidImpl } from "ulid";
export function newUlid(): string {
  return ulidImpl();
}

