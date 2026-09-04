export type {
  BashMode,
  BashPermission,
  BashRule,
  StepPermissions,
  StepRequirements,
} from './config.ts';

export type ToolSourceInfo = {
  readonly source?: string;
  readonly path?: string;
};

export type ToolInventoryItem = {
  readonly name: string;
  readonly sourceInfo?: ToolSourceInfo;
};

export type ToolAuthorization = {
  readonly allowed: boolean;
  readonly reason?: string;
};

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
