declare module "m3u8-parser" {
  export class Parser {
    manifest:
      | {
          readonly segments?: readonly unknown[];
          readonly playlists?: readonly unknown[];
        }
      | undefined;
    push(source: string): void;
    end(): void;
  }
}
