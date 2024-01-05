import useSWRSubscription, { SWRSubscription } from 'swr/subscription';
import {
  AccumulatorOptions,
  BaseDataRow,
  BaseDataSet,
  IndexerStreamAccumulateDualDataSet,
  IndexerStreamAccumulateSingleDataSet,
} from './subscribers';

interface StaleWhileRevalidateState<DataSetOrDataSets> {
  data?: DataSetOrDataSets;
  error?: Error;
}
// add higher-level hook to stream real-time DataSet or DataSets of Indexer URL
function useIndexerStream<
  DataRow extends BaseDataRow,
  DataSet = BaseDataSet<DataRow>
>(
  url: URL | string | undefined,
  IndexerClass: typeof IndexerStreamAccumulateSingleDataSet,
  opts?: AccumulatorOptions
): StaleWhileRevalidateState<DataSet>;
function useIndexerStream<
  DataRow extends BaseDataRow,
  DataSet = BaseDataSet<DataRow>
>(
  url: URL | string | undefined,
  IndexerClass: typeof IndexerStreamAccumulateDualDataSet,
  opts?: AccumulatorOptions
): StaleWhileRevalidateState<DataSet[]>;
function useIndexerStream<
  DataRow extends BaseDataRow,
  DataSet = BaseDataSet<DataRow>
>(
  url: URL | string = '',
  IndexerClass:
    | typeof IndexerStreamAccumulateSingleDataSet
    | typeof IndexerStreamAccumulateDualDataSet,
  opts?: AccumulatorOptions
): StaleWhileRevalidateState<DataSet | DataSet[]> {
  // define subscription callback which may or may not be used in this component
  // it is passed to useSWRSubscription to handle if the subscription should be
  // created/held/destroyed as multiple components may listen for the same data
  const subscribe: SWRSubscription<string, DataSet | DataSet[], Error> = (
    url,
    { next }
  ) => {
    const stream = new IndexerClass<DataRow>(
      url,
      {
        onAccumulated: (dataSet) => {
          // note: the TypeScript here is a bit hacky but this should be ok
          next(null, dataSet as unknown as DataSet | DataSet[]);
        },
        onError: (error) => next(error),
      },
      // we could pass abortController from StreamOptions here but it gets messy
      // so this has been restricted through types
      opts
    );
    return () => stream.unsubscribe();
  };

  // return cached subscription data
  return useSWRSubscription<DataSet | DataSet[], Error>(`${url}`, subscribe);
}

// higher-level hook to stream real-time DataSet of Indexer URL
export function useIndexerStreamOfSingleDataSet<
  DataRow extends BaseDataRow,
  DataSet = BaseDataSet<DataRow>
>(url: URL | string | undefined, opts?: AccumulatorOptions) {
  return useIndexerStream<DataRow, DataSet>(
    url,
    IndexerStreamAccumulateSingleDataSet,
    opts
  );
}

// higher-level hook to stream real-time DataSets of Indexer URL
export function useIndexerStreamOfDualDataSet<
  DataRow extends BaseDataRow,
  DataSet = BaseDataSet<DataRow>
>(url: URL | string | undefined, opts?: AccumulatorOptions) {
  return useIndexerStream<DataRow, DataSet>(
    url,
    IndexerStreamAccumulateDualDataSet,
    opts
  ) as StaleWhileRevalidateState<[DataSet, DataSet]>;
}
