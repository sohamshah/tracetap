export interface RawPair {
  request: {
    timestamp: number;
    method: string;
    url: string;
    headers: Record<string, string>;
    body: any;
  };
  response: {
    timestamp: number;
    // Wall-clock time (epoch seconds) when the FIRST body byte arrived from
    // upstream. Lets consumers derive time-to-first-token; absent for empty
    // bodies and for logs captured before this field existed.
    first_byte_timestamp?: number;
    status_code: number;
    headers: Record<string, string>;
    body?: any;
    body_raw?: string;
  } | null;
  logged_at: string;
  note?: string;
}

export interface ClaudeData {
  rawPairs: RawPair[];
  timestamp?: string;
  metadata?: Record<string, any>;
}

export interface HTMLGenerationData {
  rawPairs: RawPair[];
  timestamp: string;
  title?: string;
  includeAllRequests?: boolean;
}
