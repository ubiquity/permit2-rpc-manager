#!/bin/bash

# Generate list.js file based on chainid-*.js files in additionalChainRegistry
# This script must be run from the lib/chainlist directory

echo "📝 Generating list.js from additionalChainRegistry files..."
CHAIN_REGISTRY_DIR="constants/additionalChainRegistry"
LIST_FILE="$CHAIN_REGISTRY_DIR/list.js"

# Find all chainid-*.js files and sort them
CHAIN_FILES=$(find "$CHAIN_REGISTRY_DIR" -name "chainid-*.js" | sort)

# Generate the list.js content
echo "// Auto-generated file - do not edit manually" > "$LIST_FILE"
echo "" >> "$LIST_FILE"

# Generate imports
IMPORT_COUNT=0
IMPORT_VARS=""
for file in $CHAIN_FILES; do
    # Extract filename without extension and path
    filename=$(basename "$file" .js)
    # Extract chain ID from filename (chainid-XXXXX.js -> XXXXX)
    chain_id=$(echo "$filename" | sed 's/chainid-//')
    # Generate import statement with descriptive variable name
    import_var="chain_${chain_id}"
    echo "import {data as $import_var} from \"./$filename.js\"" >> "$LIST_FILE"
    IMPORT_VARS="$IMPORT_VARS $import_var"
    IMPORT_COUNT=$((IMPORT_COUNT + 1))
done

echo "" >> "$LIST_FILE"
echo "" >> "$LIST_FILE"

# Generate export statement
echo "export const overwrittenChains = [" >> "$LIST_FILE"
# Convert space-separated list to comma-separated with proper formatting
formatted_vars=$(echo "$IMPORT_VARS" | sed 's/^ *//;s/ *$//;s/ /,\n    /g')
echo "    $formatted_vars" >> "$LIST_FILE"
echo "]" >> "$LIST_FILE"

echo "✅ Generated $LIST_FILE with $IMPORT_COUNT chain imports"