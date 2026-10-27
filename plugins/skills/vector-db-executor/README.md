# Vector Database Executor Skill

A Ternlux skill plugin for performing vector database operations with automatic embedding generation.

## Features

- **Embedding Generation**: Automatically generate embeddings using OpenAI models
- **Multiple Vector Databases**: Support for LanceDB (local) and Pinecone (cloud)
- **Vector Operations**: Upsert, query (semantic search), delete, and update
- **Cost Estimation**: Automatic cost estimation for OpenAI embeddings
- **Flexible Integration**: Works with any data source in Ternlux

## Installation

### Prerequisites

- Node.js >= 14.0.0
- npm

### Setup

Run the appropriate setup script for your platform:

**Linux/Mac:**
```bash
cd plugins/skills/vector-db-executor
./setup.sh
```

**Windows:**
```cmd
cd plugins\skills\vector-db-executor
setup.bat
```

This will install all required dependencies:
- `@lancedb/lancedb` - Local vector database
- `openai` - OpenAI embeddings API

## Configuration

### API Keys

You'll need API keys for the embedding providers you want to use:

1. **OpenAI** (required — embeddings are generated with OpenAI)
   - Get your API key from: https://platform.openai.com/api-keys
   - Models: `text-embedding-3-small`, `text-embedding-3-large`, `text-embedding-ada-002`
   - Pricing: $0.02-$0.13 per 1M tokens

2. **Pinecone** (optional, only if using Pinecone cloud vector database)
   - Get your API key from: https://app.pinecone.io/
   - Requires creating an index beforehand

### Vector Databases

**LanceDB (Local)**
- Default option, no configuration required
- Stores vectors locally in your app data directory
- Supports full vector operations: upsert, query, delete, update
- No API key or external service needed

**Pinecone (Cloud)**
- Requires Pinecone API key
- Requires creating an index in Pinecone dashboard first
- Index dimension must match embedding model dimension
- Supports namespaces for data partitioning

## Usage

### Basic Workflow

1. Create a **Data Source** node with your data
2. Add a **Transformer** node
3. Use natural language to request vector operations

### Example Requests

**Embed and Store:**
```
"Embed the description column using OpenAI and store in LanceDB"
```

**Semantic Search:**
```
"Find top 10 similar items to: artificial intelligence and machine learning"
```

**Embed to Pinecone:**
```
"Embed the text column using text-embedding-3-small and upsert to Pinecone index 'my-index'"
```

**Delete Vectors:**
```
"Delete all vectors where category = 'archived'"
```

### Embedding Models

**OpenAI Models:**
- `text-embedding-3-small` (1536 dimensions, $0.02/1M tokens) - Recommended for most use cases
- `text-embedding-3-large` (3072 dimensions, $0.13/1M tokens) - Higher quality
- `text-embedding-ada-002` (1536 dimensions, $0.10/1M tokens) - Legacy model

### Operations

**Upsert (Insert/Update)**
- Loads data from source
- Generates embeddings for specified column
- Stores vectors in target database
- Preserves all original columns as metadata

**Query (Semantic Search)**
- Embeds your query text automatically
- Finds most similar vectors
- Returns results with similarity scores
- Supports metadata filtering

**Delete**
- Remove vectors by ID or metadata filter
- Works with both LanceDB and Pinecone

**Update**
- Update vector metadata without re-embedding
- Uses delete + re-add pattern for LanceDB

## Data Flow

```
Source Data
    ↓
Load from Database/File
    ↓
Extract Text Column
    ↓
Generate Embeddings (OpenAI)
    ↓
Prepare Vector Records
    ↓
Upsert to Vector DB (LanceDB/Pinecone)
    ↓
Save Results Locally
```

## Advanced Features

### Cost Estimation

For OpenAI embeddings, the skill automatically estimates costs:
- Calculates token count based on text length
- Estimates API cost before embedding
- Warns if cost exceeds $1.00

### Batch Processing

- Embeddings are generated in batches for efficiency
- OpenAI: 100 texts per batch
- Handles large datasets automatically

### Metadata Preservation

All original data columns are preserved as metadata:
```javascript
{
  id: "vec_123",
  vector: [0.1, 0.2, ...],
  metadata: {
    original_column: "value",
    _original_text: "text that was embedded",
    _embedding_model: "text-embedding-3-small",
    _embedding_provider: "openai",
    _embedded_at: "2024-03-15T10:30:00Z"
  }
}
```

### Query Auto-Embedding

When querying, your search text is automatically embedded using the same model:
```
"Find similar items to: machine learning algorithms"
                         ↓
              Auto-embedded to vector
                         ↓
              Similarity search performed
```

## Troubleshooting

### Common Issues

**"No valid text found in column"**
- Check that the specified column contains text data
- Ensure column name is spelled correctly
- Verify data isn't null or empty

**"Dimension mismatch"**
- Pinecone index dimension must match embedding model
- text-embedding-3-small = 1536 dimensions
- text-embedding-3-large = 3072 dimensions

**"API key is required"**
- Add your OpenAI API key
- Check that the key is valid and has credits

**"Table does not exist" (LanceDB)**
- For query operations, ensure you've upserted data first
- Table names are auto-created during upsert

**"Index does not exist" (Pinecone)**
- Create the index in Pinecone dashboard first
- Ensure index name matches exactly

### Performance Tips

1. **Use smaller models** for faster embedding:
   - OpenAI: text-embedding-3-small

2. **Limit data size** for large datasets:
   - Filter source data before embedding
   - Process in batches if needed

3. **Choose the right database**:
   - LanceDB: Best for local/offline use, smaller datasets
   - Pinecone: Best for production, large scale, cloud deployment

## Examples

### Example 1: Embed Product Descriptions

```
Source: products.csv (id, name, description, price)
Request: "Embed the description column and store in LanceDB as product_vectors"

Result:
- 1000 products embedded
- Stored in local LanceDB table 'product_vectors'
- Ready for semantic search
```

### Example 2: Semantic Product Search

```
Source: product_vectors (LanceDB)
Request: "Find top 5 products similar to: wireless bluetooth headphones"

Result:
ID          Score   Name                    Description
-----------------------------------------------------------
prod_123    0.89    Sony WH-1000XM4        Premium wireless...
prod_456    0.85    Bose QuietComfort     Noise cancelling...
prod_789    0.82    Jabra Elite 85h       Advanced ANC...
```

### Example 3: Pinecone Integration

```
Source: articles.db (id, title, content, category)
Request: "Embed content column using text-embedding-3-large and upsert to Pinecone index 'articles' in namespace 'tech'"

Result:
- 500 articles embedded (3072 dimensions)
- Uploaded to Pinecone index 'articles'
- Organized in 'tech' namespace
- Cost: $0.32 (estimated)
```

## Support

For issues, questions, or feature requests:
- GitHub Issues: https://github.com/your-org/ternlux/issues
- Documentation: https://ternlux.docs.io

## License

Proprietary. Copyright (c) 2026 Ternlux Inc. All rights reserved.
