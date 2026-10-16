declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(source: string): void;
    prepare(sql: string): {
      run(...args: Array<string | number | null>): { changes: number | bigint };
      get(...args: Array<string | number | null>): unknown;
    };
  }
}
