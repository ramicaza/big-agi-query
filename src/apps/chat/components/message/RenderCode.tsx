import * as React from 'react';
import { useQuery } from '@tanstack/react-query';

import { Box, IconButton, Sheet, Tooltip, Typography, CircularProgress } from '@mui/joy';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { SxProps } from '@mui/joy/styles/types';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import HtmlIcon from '@mui/icons-material/Html';
import SchemaIcon from '@mui/icons-material/Schema';
import ShapeLineOutlinedIcon from '@mui/icons-material/ShapeLineOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';

import { copyToClipboard } from '~/common/util/copyToClipboard';

import { CodeBlock } from './blocks';
import { OpenInCodepen } from './OpenInCodepen';
import { OpenInReplit } from './OpenInReplit';
import { heuristicIsHtml, IFrameComponent } from './RenderHtml';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// TODO: make these configurable in UI
const PROJECT_ID = 'symbiosys-prod';
const LOCATION = 'us-east4';
const PAGE_SIZE = 100;

// TODO: move this to an external hook for cleaner code
const useAccessTokenStore = create(persist(
  (set) => ({
    accessToken: null,
    setAccessToken: (accessToken: string) => set({ accessToken }),
  }),
  {
    name: 'access-token-storage', // unique name for localStorage key
    getStorage: () => localStorage, // define localStorage as the storage provider
  }
));

function RenderCodeImpl(props: {
  codeBlock: CodeBlock, sx?: SxProps,
  highlightCode: (inferredCodeLanguage: string | null, blockCode: string) => string,
  inferCodeLanguage: (blockTitle: string, code: string) => string | null,
  // TODO: simplify resuls and give them a proper type
  setBigQueryResult?: (results: any) => void,
}) {
  // state
  const [showHTML, setShowHTML] = React.useState(false);
  const [showSVG, setShowSVG] = React.useState(true);
  const [showPlantUML, setShowPlantUML] = React.useState(true);

  // derived props
  const { codeBlock: { blockTitle, blockCode }, highlightCode, inferCodeLanguage } = props;

  const isHTML = heuristicIsHtml(blockCode);
  const renderHTML = isHTML && showHTML;

  const isSVG = blockCode.startsWith('<svg') && blockCode.endsWith('</svg>');
  const renderSVG = isSVG && showSVG;

  const isPlantUML =
    (blockCode.startsWith('@startuml') && blockCode.endsWith('@enduml'))
    || (blockCode.startsWith('@startmindmap') && blockCode.endsWith('@endmindmap'))
    || (blockCode.startsWith('@startsalt') && blockCode.endsWith('@endsalt'))
    || (blockCode.startsWith('@startwbs') && blockCode.endsWith('@endwbs'))
    || (blockCode.startsWith('@startgantt') && blockCode.endsWith('@endgantt'));

  let renderPlantUML = isPlantUML && showPlantUML;
  const { data: plantUmlHtmlData } = useQuery({
    enabled: renderPlantUML,
    queryKey: ['plantuml', blockCode],
    queryFn: async () => {
      try {
        // Dynamically import the PlantUML encoder - it's a large library that slows down app loading
        const { encode: plantUmlEncode } = await import('plantuml-encoder');

        // retrieve and manually adapt the SVG, to remove the background
        const encodedPlantUML: string = plantUmlEncode(blockCode);
        const response = await fetch(`https://www.plantuml.com/plantuml/svg/${encodedPlantUML}`);
        const svg = await response.text();
        const start = svg.indexOf('<svg ');
        const end = svg.indexOf('</svg>');
        if (start < 0 || end <= start)
          return null;
        return svg.slice(start, end + 6).replace('background:#FFFFFF;', '');
      } catch (e) {
        // ignore errors, and disable the component in that case
        return null;
      }
    },
    staleTime: 24 * 60 * 60 * 1000, // 1 day
  });
  renderPlantUML = renderPlantUML && !!plantUmlHtmlData;

  // heuristic for language, and syntax highlight
  const { highlightedCode, inferredCodeLanguage } = React.useMemo(
    () => {
      const inferredCodeLanguage = inferCodeLanguage(blockTitle, blockCode);
      const highlightedCode = highlightCode(inferredCodeLanguage, blockCode);
      return { highlightedCode, inferredCodeLanguage };
    }, [inferCodeLanguage, blockTitle, blockCode, highlightCode]);

  // console.log('RenderCode', { blockTitle, blockCode, inferredCodeLanguage, highlightedCode });
  const languagesCodepen = ['html', 'css', 'javascript', 'json', 'typescript'];
  const canCodepen = isSVG || (!!inferredCodeLanguage && languagesCodepen.includes(inferredCodeLanguage));

  const languagesReplit = ['python', 'java', 'csharp'];
  const canReplit = !!inferredCodeLanguage && languagesReplit.includes(inferredCodeLanguage);

  const handleCopyToClipboard = (e: React.MouseEvent) => {
    e.stopPropagation();
    copyToClipboard(blockCode);
  };

  const accessToken = useAccessTokenStore(state => state.accessToken);
  const setAccessToken = useAccessTokenStore(state => state.setAccessToken);

  // TODO: move this to a hook and make it only run once during app lifetime
  // TODO: figure out how to disable gapi ts linter warnings
  React.useEffect(() => {
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
  }, []);
  const tokenClientRef = React.useRef(google.accounts.oauth2.initTokenClient({
    client_id: '361681009781-hns0m7bb5t9s09bb613vvuenr9t8o55a.apps.googleusercontent.com',
    scope: 'https://www.googleapis.com/auth/bigquery',
    // callback: handleCredentialResponse
  }));
  const tokenClient = tokenClientRef.current;

  const getToken = async (err, isInitial = false) => {
    if (isInitial) {
      // spoof error to trigger token request
      err = { result: { error: { code: 401 } } };
    }
    if (err.result?.error.code == 401 || (err.result?.error.code == 403) && (err.result?.error.status == "PERMISSION_DENIED")) {
      // The access token is missing, invalid, or expired, prompt for user consent to obtain one.
      await new Promise((resolve, reject) => {
        try {
          // Settle this promise in the response callback for requestAccessToken()
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
          location: LOCATION,
          query: query,
          useLegacySql: false,
          dryRun: dryRun,
          // 'maxResults': PAGE_SIZE,
          maxResults: 0, // actual results are fetched in attemptQueryResults
          timeoutMs: 180000, // we never want to deal with the job id, almost any query is faster than 3 min
          formatOptions: {
            useInt64Timestamp: false,
          },
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

    const attemptQueryResults = async (
      jobId: string, startRow: number | null = null
    ) => gapi.client.bigquery.jobs.getQueryResults({
      'projectId': PROJECT_ID,
      'location': LOCATION,
      'jobId': jobId,
      'maxResults': PAGE_SIZE,
      'timeoutMs': 180000, // we never want to deal with the job id, almost any query is faster than 3 min
      'startIndex': startRow,
    });

    const getQueryResultsWithRetry = async (jobId: string, startRow: number | null = null) => {
      try {
        if (!jobId || (startRow !== 0 && !startRow)) throw new Error('No jobId or startRow provided');
        return await attemptQueryResults(jobId, startRow);
      } catch (error) {
        if (autoLogin) {
          await getToken(error); // Attempt to get a new token
          return await attemptQueryResults(jobId, startRow); // Retry the query
        } else {
          throw error; // If autoLogin is false, throw the error
        }
      }
    };

    let jobId: string;

    // Function to fetch the next page
    const fetchNextPage = async (request: { startRow: number }) => {
      const { result: nextPageResults } = await getQueryResultsWithRetry(jobId, request.startRow);
      return nextPageResults; // Return the next page of results
    };
    // Execute the initial query and get the first page of results
    const resp = await queryWithRetry();
    jobId = resp.result.jobReference.jobId;

    // Return the first page of results along with the fetchNextPage function
    resp.result.fetchNextPage = fetchNextPage;
    return resp;
  };

  const [loadingQuery, setLoadingQuery] = React.useState(false);
  const [queryError, setQueryError] = React.useState(null);

  const runQuery = async () => {
    setLoadingQuery(true);
    if (!accessToken) {
      console.log('No access token, attempting to get one');
      await getToken(null, true);
    }
    console.log('Attempting to execute query');
    try {
      const resp = await executeQuery(blockCode, false);
      console.log('Query response', resp);
      const billableBytes = resp.result.totalBytesProcessed;
      console.log(`Billable bytes: ${billableBytes}`);
      props.setBigQueryResult && props.setBigQueryResult(resp.result);
    } catch (err: any) {
      console.error('Query error during run', err);
      console.log(err?.result?.error?.message || err?.result?.error?.status);
      setQueryError(err?.result?.error?.message || err?.result?.error?.status);
    }
    setLoadingQuery(false);
  };

  const [loadingCost, setLoadingCost] = React.useState(false);
  const [estimatedCost, setEstimatedCost] = React.useState<number | null>(null);
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
      const resp = await executeQuery(blockCode, true, userInitiated);
      const billableBytes = resp.result.totalBytesProcessed;
      console.log(`Billable bytes: ${billableBytes}`);
      const cost = billableBytes * (6.25 / Math.pow(2, 40));
      setEstimatedCost(cost);
    } catch (err: any) {
      console.error('Query error during estimateCost', err);
      setQueryError(err?.result?.error?.message || err?.result?.error?.status);
    }
    setLoadingCost(false);
  };

  const prevCompleteRef = React.useRef(props.codeBlock.complete);
  React.useEffect(() => {
    if (!prevCompleteRef.current && props.codeBlock.complete && inferredCodeLanguage === 'sql') {
      estimateCost(false);
    }
    prevCompleteRef.current = props.codeBlock.complete;
  }, [props.codeBlock.complete]); // Only re-run the effect if props.codeBlock.complete changes

  return (
    <Box
      component='code'
      className={`language-${inferredCodeLanguage || 'unknown'}`}
      sx={{
        position: 'relative', mx: 0, p: 1.5, // this block gets a thicker border
        display: 'block', fontWeight: 500,
        whiteSpace: 'pre', // was 'break-spaces' before we implmented per-block scrolling
        overflowX: 'auto',
        '&:hover > .code-buttons': { opacity: 1 },
        ...(props.sx || {}),
      }}>
      {/* SQL Error Banner */}
      {queryError && (
        <Box className="sql-error-banner" sx={{
          backgroundColor: 'rgba(255, 0, 0, 0.1)',
          color: 'error.contrastText',
          p: 1, borderRadius: 'sm',
          display: 'inline-flex', alignItems: 'center', // Changed from 'flex' to 'inline-flex'
        }}>
          <ErrorOutlineIcon color="error" sx={{ fontSize: 'inherit', mr: 1 }} />
          <Typography level="body-xs" sx={{ fontWeight: 500 }}>{queryError}</Typography>
        </Box>
      )}
      <Box
        className='code-buttons'
        sx={{
          backdropFilter: 'blur(8px)', // '... grayscale(0.8)
          position: 'absolute', top: 0, right: 0, zIndex: 10, p: 0.5,
          display: 'flex', flexDirection: 'row', gap: 1,
          opacity: 0, transition: 'opacity 0.3s',
          // '& > button': { backdropFilter: 'blur(6px)' },
        }}>
        {isSVG && (
          <Tooltip title={renderSVG ? 'Show Code' : 'Render SVG'} variant='solid'>
            <IconButton variant={renderSVG ? 'solid' : 'soft'} color='neutral' onClick={() => setShowSVG(!showSVG)}>
              <ShapeLineOutlinedIcon />
            </IconButton>
          </Tooltip>
        )}
        {isHTML && (
          <Tooltip title={renderHTML ? 'Hide' : 'Show Web Page'} variant='solid'>
            <IconButton variant={renderHTML ? 'solid' : 'soft'} color='danger' onClick={() => setShowHTML(!showHTML)}>
              <HtmlIcon />
            </IconButton>
          </Tooltip>
        )}
        {isPlantUML && (
          <Tooltip title={renderPlantUML ? 'Show Code' : 'Render PlantUML'} variant='solid'>
            <IconButton variant={renderPlantUML ? 'solid' : 'soft'} color='neutral' onClick={() => setShowPlantUML(!showPlantUML)}>
              <SchemaIcon />
            </IconButton>
          </Tooltip>
        )}
        {canCodepen && <OpenInCodepen codeBlock={{ code: blockCode, language: inferredCodeLanguage || undefined }} />}
        {canReplit && <OpenInReplit codeBlock={{ code: blockCode, language: inferredCodeLanguage || undefined }} />}
        <Tooltip title='Copy Code' variant='solid'>
          <IconButton variant='outlined' color='neutral' onClick={handleCopyToClipboard}>
            <ContentCopyIcon />
          </IconButton>
        </Tooltip>
        {inferredCodeLanguage === 'sql' && (
          <>
            <Tooltip title="Cost Estimate" variant='solid'>
              <IconButton variant='outlined' color='neutral' onClick={() => estimateCost(true)}>
                {loadingCost ? <CircularProgress size='sm' /> :
                  <Typography level='body-xs'>
                    {estimatedCost === null ? 'Cost Est.' :
                      estimatedCost < 0.01 ? '<1¢' :
                        estimatedCost < 1 ? `${(estimatedCost * 100).toFixed(0)}¢` :
                          `$${estimatedCost.toFixed(2)}`
                    }
                  </Typography>
                }
              </IconButton>
            </Tooltip>
            <Tooltip title="Run in BQ" variant='solid'>
              <IconButton
                variant='outlined'
                color={estimatedCost === null ? 'neutral' : 'success'}
                onClick={runQuery}
              >
                {loadingQuery ? <CircularProgress size='sm' /> : <PlayArrowIcon color={estimatedCost === null ? 'disabled' : 'success'} />}
              </IconButton>
            </Tooltip>
          </>
        )}
      </Box>

      {/* Title (highlighted code) */}
      {
        blockTitle != inferredCodeLanguage && blockTitle.includes('.') && <Sheet sx={{ boxShadow: 'sm', borderRadius: 'sm', mb: 1 }}>
          <Typography level='title-sm' sx={{ px: 1, py: 0.5 }}>
            {blockTitle}
            {/*{inferredCodeLanguage}*/}
          </Typography>
        </Sheet>
      }

      {/* Renders HTML, or inline SVG, inline plantUML rendered, or highlighted code */}
      {
        renderHTML ? <IFrameComponent htmlString={blockCode} />
          : <Box
            dangerouslySetInnerHTML={{
              __html:
                renderSVG ? blockCode
                  : (renderPlantUML && plantUmlHtmlData) ? plantUmlHtmlData
                    : highlightedCode,
            }}
            sx={{
              ...(renderSVG ? { lineHeight: 0 } : {}),
              ...(renderPlantUML ? { textAlign: 'center' } : {}),
            }}
          />
      }
    </Box >
  );
}

// Dynamically import the heavy prism functions
const RenderCodeDynamic = React.lazy(async () => {

  // Dynamically import the code highlight functions
  const { highlightCode, inferCodeLanguage } = await import('./codePrism');

  return {
    default: (props: { codeBlock: CodeBlock, sx?: SxProps }) =>
      <RenderCodeImpl highlightCode={highlightCode} inferCodeLanguage={inferCodeLanguage} {...props} />,
  };
});

export const RenderCode = (props: { codeBlock: CodeBlock, sx?: SxProps, setBigQueryResult: (result: any) => void }) =>
  <React.Suspense fallback={<Box component='code' sx={{ p: 1.5, display: 'block', ...(props.sx || {}) }} />}>
    <RenderCodeDynamic {...props} />
  </React.Suspense>;