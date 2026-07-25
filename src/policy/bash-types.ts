export type BashAuthorization = {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly tokens?: Array<string>;
};

export type RestrictedCommandTokens =
  | {
      readonly tokens: Array<string>;
      readonly error?: never;
    }
  | {
      readonly tokens?: never;
      readonly error: string;
    };

export type RestrictedGitCommand = {
  readonly subcommand: string;
  readonly subcommandIndex: number;
};
