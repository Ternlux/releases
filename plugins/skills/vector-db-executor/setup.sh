#!/bin/bash

# Vector DB Executor Skill Setup Script
# This script installs the necessary dependencies for the Vector DB Executor skill

echo "=================================="
echo "Vector DB Executor Skill Setup"
echo "=================================="
echo ""

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "Error: npm is not installed. Please install Node.js and npm first."
    exit 1
fi

echo "Installing dependencies..."
echo ""

# Install dependencies
npm install

if [ $? -eq 0 ]; then
    echo ""
    echo "=================================="
    echo "✓ Setup completed successfully!"
    echo "=================================="
    echo ""
    echo "The Vector DB Executor skill is now ready to use."
    echo ""
    echo "Next steps:"
    echo "1. Restart Ternlux to load the skill"
    echo "2. Add your API keys:"
    echo "   - OpenAI API key (for OpenAI embeddings)"
    echo "   - Pinecone API key (if using Pinecone)"
    echo "3. Create a transformer node and request a vector operation"
    echo ""
    echo "Example usage:"
    echo '  "Embed the description column using OpenAI and store in LanceDB"'
    echo '  "Find top 10 similar items to: sample query text"'
    echo ""
else
    echo ""
    echo "=================================="
    echo "✗ Setup failed"
    echo "=================================="
    echo ""
    echo "Please check the error messages above and try again."
    echo "If the problem persists, please report it on GitHub."
    exit 1
fi
