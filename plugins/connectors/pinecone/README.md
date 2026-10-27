# Pinecone Connector for Ternlux

Vector database connector for Pinecone.io

## Installation

```bash
cd plugins/connectors/pinecone
npm install
```

## Configuration

- **API Key**: Your Pinecone API key (required)
- **Environment**: Pinecone environment (optional, auto-detected)

## Dependencies

This connector requires the `vector-db-executor` skill to be installed for transformations.

## Supported Operations

- **query**: Similarity search with vector
- **fetch**: Fetch vectors by IDs
- **upsert**: Insert or update vectors
- **update**: Update existing vector
- **delete**: Delete vectors by IDs or filter

## Example Usage

### Query (Similarity Search)
```javascript
{
  indexName: 'my-index',
  operation: 'query',
  vector: [0.1, 0.2, 0.3, ...], // Your query vector
  topK: 10,
  namespace: 'my-namespace',
  filter: { category: 'product' }
}
```

### Upsert Vectors
```javascript
{
  indexName: 'my-index',
  operation: 'upsert',
  namespace: 'my-namespace',
  vectors: [
    { id: 'vec1', values: [0.1, 0.2, ...], metadata: { text: 'example' } }
  ]
}
```
