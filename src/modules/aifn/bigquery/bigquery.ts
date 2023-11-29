import React, { useState, useEffect, useRef, useCallback } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// TODO: make these configurable in UI
const PROJECT_ID = 'symbiosys-prod';
const PAGE_SIZE = 100;

interface AccessTokenStoreState {
  accessToken: string | null;
  setAccessToken: (accessToken: string) => void;
}
const useAccessTokenStore = create<AccessTokenStoreState>()(persist(
  (set) => ({
    accessToken: null,
    setAccessToken: (accessToken: string) => set({ accessToken }),
  }),
  {
    name: 'access-token-storage', // unique name for localStorage key
    getStorage: () => localStorage, // define localStorage as the storage provider
  }
));

interface BigQueryHookReturn {
  loadingQuery: boolean;
  queryError: any; // You may want to define a more specific type for the error
  loadingCost: boolean;
  estimatedCost: number | null;
  estimateCost: (userInitiated?: boolean) => Promise<void>;
  runQuery: () => Promise<void>;
  getTableSchema: (projectId: string | undefined, datasetId: string, tableId: string) => Promise<any>; // Define a more specific type for the schema if possible
}

let loadedGapi = false;
let tokenClient: google.accounts.oauth2.TokenClient;

export const useBigQuery = (query: string, setBigQueryResult?: (results: any) => void): BigQueryHookReturn => {
  const accessToken = useAccessTokenStore((state) => state.accessToken);
  const setAccessToken = useAccessTokenStore((state) => state.setAccessToken);

  const [loadingQuery, setLoadingQuery] = useState(false);
  const [queryError, setQueryError] = useState<null | string>(null);
  const [loadingCost, setLoadingCost] = useState(false);
  const [estimatedCost, setEstimatedCost] = useState<number | null>(null);
  const [loadingSchema, setLoadingSchema] = useState(false);

  // Initialize GAPI client only once
  useEffect(() => {
    if (loadedGapi) return;
    loadedGapi = true;

    gapi.load('client', () => {
      if (accessToken) {
        console.log('Found access token, setting it in gapi.client')
        gapi.client.setToken({ access_token: accessToken });
      }
      console.log('Loaded gapi.client');
      gapi.client.load('bigquery', 'v2').then(() => {
        console.log('Loaded gapi.client.bigquery');
      });
    });

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: '361681009781-hns0m7bb5t9s09bb613vvuenr9t8o55a.apps.googleusercontent.com',
      scope: 'https://www.googleapis.com/auth/bigquery',
      callback: () => null
    })
  }, []);

  const getToken = async (err: any, isInitial = false) => {
    if (isInitial) {
      // spoof error to trigger token request
      err = { result: { error: { code: 401 } } };
    }
    if (err.result?.error.code == 401 || (err.result?.error.code == 403) && (err.result?.error.status == "PERMISSION_DENIED")) {
      // The access token is missing, invalid, or expired, prompt for user consent to obtain one.
      await new Promise((resolve, reject) => {
        try {
          // Settle this promise in the response callback for requestAccessToken()
          // @ts-ignore
          tokenClient.callback = (resp) => {
            console.log('tokenClient.callback', resp);
            console.log(resp.error !== undefined)
            if (resp.error !== undefined) {
              reject(resp);
            }
            // GIS has automatically updated gapi.client with the newly issued access token.
            console.log('gapi.client access token: ' + JSON.stringify(gapi.client.getToken()));
            setAccessToken(gapi.client.getToken().access_token); // TODO: persist this
            resolve(resp);
          };
          tokenClient.requestAccessToken();
        } catch (err) {
          console.log(err)
        }
      });
    } else {
      // Errors unrelated to authorization: server errors, exceeding quota, bad requests, and so on.
      throw err;
    }
  }

  // executeQuery queries & retries and exposes a fetchNextPage function, all bound to a single query/job
  const executeQuery = async (query: string, dryRun: boolean = false, autoLogin = true) => {
    // Function to attempt the query with optional pageToken
    const attemptQuery = async () => {
      return gapi.client.bigquery.jobs.query({
        'projectId': PROJECT_ID,
        'resource': {
          query: query,
          useLegacySql: false,
          dryRun: dryRun,
          // 'maxResults': PAGE_SIZE,
          maxResults: 0, // actual results are fetched in attemptQueryResults
          timeoutMs: 180000, // we never want to deal with the job id, almost any query is faster than 3 min
          // formatOptions: {
          //   useInt64Timestamp: true,
          // },
        },
      });
    }
    // Function to handle the actual query execution and error handling
    const queryWithRetry = async () => {
      try {
        return await attemptQuery();
      } catch (error) {
        if (autoLogin) {
          await getToken(error); // Attempt to get a new token
          return await attemptQuery(); // Retry the query
        } else {
          throw error; // If autoLogin is false, throw the error
        }
      }
    };

    const attemptQueryResults = async (startRow: number | null = null) => gapi.client.bigquery.jobs.getQueryResults({
      'projectId': PROJECT_ID,
      'location': location,
      'jobId': jobId,
      'maxResults': PAGE_SIZE,
      'timeoutMs': 180000, // we never want to deal with the job id, almost any query is faster than 3 min
      'startIndex': startRow ? '' + startRow : undefined,
    });

    const getQueryResultsWithRetry = async (startRow: number | null = null) => {
      try {
        if (!jobId || !location || (startRow !== 0 && !startRow)) throw new Error('One of {jobId, location, startRow} not provided');
        return await attemptQueryResults(startRow);
      } catch (error) {
        if (autoLogin) {
          await getToken(error); // Attempt to get a new token
          return await attemptQueryResults(startRow); // Retry the query
        } else {
          throw error; // If autoLogin is false, throw the error
        }
      }
    };

    let jobId: string;
    let location: string;

    // Function to fetch the next page
    const fetchNextPage = async (request: { startRow: number }) => {
      const { result: nextPageResults } = await getQueryResultsWithRetry(request.startRow);
      return nextPageResults; // Return the next page of results
    };
    // Execute the initial query and get the first page of results
    const resp: any = await queryWithRetry();
    jobId = resp.result.jobReference.jobId;
    location = resp.result.jobReference.location;

    // Return the first page of results along with the fetchNextPage function
    resp.result.fetchNextPage = fetchNextPage;
    return resp;
  };

  const runQuery = async () => {
    setLoadingQuery(true);
    if (!accessToken) {
      console.log('No access token, attempting to get one');
      await getToken(null, true);
    }
    console.log('Attempting to execute query');
    try {
      const resp = await executeQuery(query, false);
      console.log('Query response', resp);
      const billableBytes = resp.result.totalBytesProcessed;
      console.log(`Billable bytes: ${billableBytes}`);
      setBigQueryResult && setBigQueryResult(resp.result);
      setQueryError(null);
    } catch (err: any) {
      console.error('Query error during run', err);
      setQueryError(err?.result?.error?.message || err?.result?.error?.status);
    }
    setLoadingQuery(false);
  };

  const estimateCost = async (userInitiated = true) => {
    setLoadingCost(true);
    if (!accessToken) {
      if (userInitiated) {
        console.log('No access token, attempting to get one');
        await getToken(null, true);
      } else {
        console.log('No access token, skipping auto-estimate');
        setLoadingCost(false);
        return; // no need to annoy user with auth prompt for a cost estimate
      }
    }
    console.log('Attempting to estimate cost');
    try {
      const resp = await executeQuery(query, true, userInitiated);
      const billableBytes = resp.result.totalBytesProcessed;
      console.log(`Billable bytes: ${billableBytes}`);
      const cost = billableBytes * (6.25 / Math.pow(2, 40));
      setEstimatedCost(cost);
      setQueryError(null);
    } catch (err: any) {
      console.error('Query error during estimateCost', err);
      if (err?.status === 401) {
        setQueryError('Please press the "Cost Estimate" button to log-in and evaluate this query');
      } else {
        setQueryError(err?.result?.error?.message || err?.result?.error?.status);
      }
    }
    setLoadingCost(false);
  };

  const getTableSchema = async (projectId: string | undefined, datasetId: string, tableId: string) => {
    setLoadingSchema(true); // Assuming there is a similar state for loading schema

    // Helper function to attempt to fetch the table schema
    const attemptGetTableSchema = async () => {
      return await gapi.client.bigquery.tables.get({
        projectId: projectId || PROJECT_ID,
        datasetId: datasetId,
        tableId: tableId
      });
    };

    // Function to handle the actual table schema retrieval and error handling
    const getTableSchemaWithRetry = async () => {
      try {
        return await attemptGetTableSchema();
      } catch (error: any) {
        // Check if the error is related to authentication and if autoLogin is enabled
        if (error.status === 401 || error.status === 403) {
          console.log('Authentication error, attempting to get a new token');
          await getToken(error, true); // Attempt to get a new token
          return await attemptGetTableSchema(); // Retry the table schema retrieval
        } else {
          throw error; // If the error is not auth-related or autoLogin is disabled, throw the error
        }
      }
    };

    try {
      if (!accessToken) {
        console.log('No access token, attempting to get one');
        await getToken(null, true);
      }
      const res = await getTableSchemaWithRetry();
      return res.result.schema;
    } catch (error) {
      console.error('Error fetching table schema:', error);
      throw error;
    } finally {
      setLoadingSchema(false);
    }
  };

  // Expose the state and functions
  return {
    loadingQuery,
    queryError,
    loadingCost,
    estimatedCost,
    estimateCost,
    runQuery,
    getTableSchema,
  };
};
