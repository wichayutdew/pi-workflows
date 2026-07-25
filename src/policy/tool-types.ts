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
