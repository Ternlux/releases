# Ternlux Skills Plugins

Skills are specialized plugins that enhance TransformerNodeChat and JoinNodeChat with custom execution capabilities beyond standard SQL/NoSQL operations.

## What are Skills?

Skills are plugins that provide alternative execution methods for data transformations and joins. Instead of generating SQL or NoSQL queries, skills can execute custom code (Python, JavaScript, etc.) directly on your local machine.

## Skills vs Connectors

- **Connectors**: Connect to data sources (databases, files, APIs) for reading/writing data
- **Skills**: Enhance transformation and join operations with custom execution engines

## Creating a Skill Plugin

A skill plugin must export the following structure:

```javascript
module.exports = {
  type: 'skill',
  id: 'unique-skill-id',
  name: 'Skill Name',
  icon: './icon.svg',
  category: 'transformer' | 'join',  // or 'both', or 'chat' (main chat only)

  /**
   * Get description for AI context
   * Helps the AI understand when to use this skill
   */
  getDescription: () => ({
    name: 'Skill Name',
    description: 'What this skill does',
    capabilities: [
      'Capability 1',
      'Capability 2'
    ],
    inputFormat: 'Expected input format',
    outputFormat: 'Expected output format',
    executionEnvironment: 'local' | 'remote'
  }),

  /**
   * Get prompts to add to transformation/join requests
   * Provides context to the AI about how to use this skill
   */
  getTransformPrompts: () => ({
    systemContext: 'Additional context for the AI system prompt',
    responseFormat: 'Expected response format when using this skill'
  }),

  /**
   * Execute the skill
   * @param {Object} params - Execution parameters
   * @returns {Promise<Object>} - Execution result
   */
  execute: async (params) => {
    // Your execution logic here
    return {
      success: true,
      data: transformedData,
      recordCount: number
    };
  },

  /**
   * Plugin metadata
   */
  metadata: {
    displayName: 'Skill Display Name',
    description: 'Detailed description',
    version: '1.0.0',
    author: 'Author Name',
    requires: ['dependency1', 'dependency2'],
    documentationUrl: 'https://docs.example.com'
  }
};
```

## Skill Categories

### Transformer Skills

Used in TransformerNodeChat to provide alternative transformation methods:

- **Category**: `transformer`
- **Use Cases**: Complex data transformations, custom business logic, scientific computing
- **Examples**: Python Executor, R Scripts, Custom JavaScript transformers

### Join Skills

Used in JoinNodeChat to provide alternative join methods:

- **Category**: `join`
- **Use Cases**: Complex multi-source joins, fuzzy matching, custom join logic
- **Examples**: Python pandas joins, custom similarity joins

## How Skills are Selected

When a user requests a transformation or join:

1. The AI analyzes the request and available skills
2. If a skill is better suited than SQL/NoSQL, the AI sets `usesSkill: true`
3. The skill's `execute()` method is called instead of generating SQL/NoSQL
4. The skill returns transformed/joined data

## Installing Skills

Skills are automatically discovered from the `plugins/skills/` directory structure:

```
plugins/
  skills/
    python-executor/
      index.js
      package.json
      icon.svg
      README.md
    custom-join/
      index.js
      package.json
      icon.svg
      README.md
```

## Execution Flow

### For Transformations

1. User requests transformation in TransformerNodeChat
2. AI includes skill descriptions in context
3. If AI selects a skill:
   ```json
   {
     "usesSkill": true,
     "skillId": "python-executor",
     "skillExplanation": "Using Python for pandas-based transformation",
     "pythonCode": "def transform(data): ..."
   }
   ```
4. Skill's `execute()` method is called with parameters
5. Transformed data is returned and used in workflow

### For Joins

1. User requests join in JoinNodeChat
2. AI includes skill descriptions in context
3. If AI selects a skill:
   ```json
   {
     "usesSkill": true,
     "skillId": "python-join",
     "skillExplanation": "Using Python pandas for complex join",
     "pythonCode": "def join_data(source1, source2): ..."
   }
   ```
4. Skill's `execute()` method is called with source data
5. Joined data is returned and saved to destination

## Example: Python Executor Skill

See `plugins/skills/python-executor/` for a complete example that:

- Executes arbitrary Python code
- Supports pandas, numpy, and other libraries
- Handles data serialization/deserialization
- Provides error handling and timeouts

## Best Practices

1. **Clear Descriptions**: Help the AI understand when to use your skill
2. **Input Validation**: Validate parameters before execution
3. **Error Handling**: Return clear error messages
4. **Timeouts**: Prevent infinite loops/long-running processes
5. **Security**: Validate and sanitize user input (especially for code execution)
6. **Documentation**: Provide clear README with examples

## Security Considerations

Skills that execute code (like Python Executor) should:

- Run in isolated environments when possible
- Implement timeouts
- Validate inputs
- Limit file system access
- Not execute untrusted code without sandboxing

## Testing Your Skill

1. Place your skill in `plugins/skills/your-skill-name/`
2. Restart the Ternlux application
3. Check ConnectionTypeSelector → Skills tab
4. Your skill should appear if properly structured
5. Test in a TransformerNodeChat or JoinNodeChat

## Contributing Skills

To contribute a skill to Ternlux:

1. Create the skill following the structure above
2. Add comprehensive README documentation
3. Include example usage
4. Add tests if possible
5. Submit a pull request

## Chat Skills

A skill with `category: 'chat'` is used only by the main chat assistant, through a
tool of its own, and is never offered to TransformerNodeChat or JoinNodeChat. See
`plugins/skills/presentation/` (the `build_presentation` tool).

## Available Skills

### Python Executor
- **ID**: `python-executor`
- **Category**: transformer
- **Description**: Execute Python code for complex transformations
- **Requires**: Python 3.6+
- **Location**: `plugins/skills/python-executor/`
