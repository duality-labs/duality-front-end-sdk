# Duality Front End SDK

A collection of useful component hooks and tools to interact with the Duality
Dex chain and indexer for front ends.

## Get Started

`npm install @duality-labs/duality-front-end-sdk`

## Using indexer data

See also:
- https://github.com/duality-labs/hapi-indexer
- https://hadron.notion.site/Indexer-API-a2eabb732292453196332cb2727e53f7

Subscribing to indexer data updates may seem complicated at first, given that
the event stream returns partial updates and these updates need to be
accumulated into a usable data state. The exposed classes here should help:

- `IndexerStream<DataRow>`
- `IndexerStreamAccumulateSingleDataSet<DataRow, DataSet>`
- `IndexerStreamAccumulateDualDataSet<DataRow, DataSet>`
- where `DataRow` is a TypeScript interface of an endpoint's row data shape
- where `DataSet` is a Map type defining data accumulation from rows into a map

A set of abstracted functions for higher level usage includes functions that
mimic `fetch` behavior, awaiting for all requested data before resolving:

- `fetchSingleDataSetFromIndexer<DataRow>`
- `fetchDualDataSetFromIndexer<DataRow>`

And React hook implementations to track a cumulative data state with each update
- `useIndexerStreamOfSingleDataSet<DataRow>`
- `useIndexerStreamOfDualDataSet<DataRow>`


### Indexer usage Examples

This allows an abstraction of examples such as the following

A simple fetch replacement, including [abortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController) option:

```ts
import { fetchSingleDataSetFromIndexer } from '@duality-labs/duality-front-end-sdk';

type TimeSeriesRow = [unixTime: number, values: number[]];
type TimeSeriesDataSet = Map<TimeSeriesRow['0'], TimeSeriesRow['1']>

async function getSortedTimeseries(url: string): Promise<TimeSeriesRow[]> {
  const data: TimeSeriesDataSet =
    await fetchSingleDataSetFromIndexer<TimeSeriesRow>(url);
  return Array.from(data)
    // sort by index (chronological timestamp)
    .sort(([a], [b]) => a - b);
}

```

or using an AbortController in a bad practice React useEffect fetch (demonstrating cleanup)

```ts
import { fetchSingleDataSetFromIndexer } from '@duality-labs/duality-front-end-sdk';

useEffect(() => {
  const abortController = new AbortController();
  fetchSingleDataSetFromIndexer<TimeSeriesRow>(url, { abortController })
    .then((data: TimeSeriesDataSet): TimeSeriesRow[] => {
      return (
        Array.from(data)
          // sort by index (chronological timestamp)
          .sort(([a], [b]) => a - b)
      );
    })
    .then(setData);
  // cleanup by aborting the fetch
  return () => abortController.abort();
}, [url]);
```

Subscribing to updates using base data accumulation Class:

```ts
import { IndexerStreamAccumulateSingleDataSet } from '@duality-labs/duality-front-end-sdk';

// to pass update data to a higher-level `onRealtimeCallback` function
new IndexerStreamAccumulateSingleDataSet<TimeSeriesRow>(url, {
  onUpdate: (dataUpdates) => {
    // note: TradingView data needs to be in chronological order
    // and our indexer API delivers results in reverse-chronological order
    const chronologicalUpdates = dataUpdates.reverse();
    for (const row of chronologicalUpdates) {
      // translate indexer API data row into TradingView candle object
      onRealtimeCallback(getBarFromTimeSeriesRow(row));
    }
  },
});
```

Subscribing to updates using data accumulation React Hooks:

```ts
import { useMemo } from 'react';
import { useIndexerStreamOfSingleDataSet } from '@duality-labs/duality-front-end-sdk';

export type TokenPairReserves = [
  token0: string,
  token1: string,
  reserve0: number,
  reserve1: number
];
type DataRow = [index: number, values: TokenPairReserves];

type TokenPairsState = {
  data: TokenPairReserves[] | undefined;
  error: Error | null;
};

export default function useTokenPairs(): TokenPairsState {
  const { data, error } =
    useIndexerStreamOfSingleDataSet<DataRow>(`${indexerAPI}/liquidity/pairs`);

  const values: TokenPairReserves[] | undefined = useMemo(() => {
    if (data) {
      const values = Array.from(data)
        .sort(([a], [b]) => a - b)
        .map((row) => row[1]);
      return values;
    }
  }, [data]);

  // return state
  return { data: values, error: error || null };
}
```

Subscribing to updates of a multiple dataset endpoint with React Hooks

```ts
import { useIndexerStreamOfDualDataSet } from '@duality-labs/duality-front-end-sdk';

type ReserveDataRow = [tickIndex: number, reserves: number];
type ReserveDataSet = Map<ReserveDataRow['0'], ReserveDataRow['1']>;

// add convenience method to fetch liquidity maps of a pair
export function useTokenPairMapLiquidity([tokenIdA, tokenIdB]: [string?, string? ]): {
  // note that two data sets are returned by useIndexerStreamOfDualDataSet
  data?: [ReserveDataSet, ReserveDataSet];
  error?: unknown;
} {
  // stream data from indexer
  return useIndexerStreamOfDualDataSet<ReserveDataRow>(
    tokenIdA && tokenIdB && `${indexerAPI}/liquidity/pair/${tokenIdA}/${tokenIdB}`,
    {
      // remove entries of value 0 from the accumulated map, they are not used
      mapEntryRemovalValue: 0,
    }
  );
}
```
