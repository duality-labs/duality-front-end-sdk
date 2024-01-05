import {
  AccumulatorOptions,
  BaseDataRow,
  BaseDataSet,
  IndexerStreamAccumulateDualDataSet,
  IndexerStreamAccumulateSingleDataSet,
  StreamOptions,
  accumulateUpdatesUsingMutation
} from "./subscribers";

// add higher-level functions to fetch multiple pages of data as "one request"
async function fetchDataFromIndexer<DataRow extends BaseDataRow>(
  baseURL: URL | string,
  IndexerClass: typeof IndexerStreamAccumulateSingleDataSet,
  opts?: AccumulatorOptions & StreamOptions
): Promise<BaseDataSet<DataRow>>;
async function fetchDataFromIndexer<DataRow extends BaseDataRow>(
  baseURL: URL | string,
  IndexerClass: typeof IndexerStreamAccumulateDualDataSet,
  opts?: AccumulatorOptions & StreamOptions
): Promise<BaseDataSet<DataRow>[]>;
async function fetchDataFromIndexer<DataRow extends BaseDataRow>(
  baseURL: URL | string,
  IndexerClass:
    | typeof IndexerStreamAccumulateSingleDataSet
    | typeof IndexerStreamAccumulateDualDataSet,
  opts?: AccumulatorOptions & StreamOptions
): Promise<BaseDataSet<DataRow> | BaseDataSet<DataRow>[]> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseURL);
    // set max height to now, which will cause the request to end at now height
    const before = Date.now() / 1000;
    url.searchParams.append('pagination.before', before.toFixed(0));
    // add stream listener and resolve promise on completion
    const stream = new IndexerClass<DataRow>(
      url,
      {
        onCompleted: (data) => {
          stream.unsubscribe();
          resolve(data);
        },
        onError: reject,
      },
      opts
    );
    // allow mutation in this stream accumulator because we won't listen to
    // individual data updates
    stream.accumulateUpdates = accumulateUpdatesUsingMutation;
  });
}

export function fetchSingleDataSetFromIndexer<DataRow extends BaseDataRow>(
  url: URL | string,
  opts?: AccumulatorOptions & StreamOptions
): Promise<BaseDataSet<DataRow>> {
  return fetchDataFromIndexer(url, IndexerStreamAccumulateSingleDataSet, opts);
}

export function fetchDualDataSetFromIndexer<DataRow extends BaseDataRow>(
  url: URL | string,
  opts?: AccumulatorOptions & StreamOptions
): Promise<BaseDataSet<DataRow>[]> {
  return fetchDataFromIndexer(url, IndexerStreamAccumulateDualDataSet, opts);
}