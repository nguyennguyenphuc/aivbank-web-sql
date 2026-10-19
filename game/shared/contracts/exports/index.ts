export interface CompatibilityTableStatus {
  table: string;
  rows: number;
}

export interface CompatibilityStatus {
  tables: CompatibilityTableStatus[];
  totalRows: number;
}
