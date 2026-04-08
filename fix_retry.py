# Fix attemptSqlWithRetry function in chat.ts
with open(r'D:\Phuong\workspace\ai-data-platform\server\src\routes\chat.ts', encoding='utf-8') as f:
    content = f.read()

# Find function boundaries
start = content.find('async function attemptSqlWithRetry(')
end = content.find('\nfunction buildFixPrompt(')
if start == -1 or end == -1:
    print(f'Not found: start={start}, end={end}')
    exit(1)

print(f'Found function at {start}-{end} ({end-start} chars)')

before = content[:start]
after = content[end:]

# Fix buildFixPrompt type
after = after.replace(
    "type: 'SYNTAX' | 'DATABASE'",
    "type: 'SYNTAX' | 'DATABASE' | 'COLUMN'"
)

# Fix callers - find the SSE stream caller first (pattern with schemaDescription)
old_sse = '''retryResult = await attemptSqlWithRetry(\n        poolRef,\n        parsed.sql,\n        schemaDescription,\n        message,\n      );'''
new_sse = '''retryResult = await attemptSqlWithRetry(\n        poolRef,\n        parsed.sql,\n        schemaDescription,\n        message,\n        schemaJson,\n      );'''
after = after.replace(old_sse, new_sse)

# Fix non-stream caller
old_nonstream = '''retryResult = await attemptSqlWithRetry(\n            execPool,\n            parsed.sql ?? generationResult.sql ?? '',\n            systemPrompt,\n            createChatModel(\n              keyRecord.provider,\n              keyRecord.api_key,\n              getChatModelConfig(keyRecord.provider, keyRecord.api_key, model),\n            ),\n            2,\n            req.userId!,\n            connection.id,\n            focusedSchema,\n            message,\n          );'''
new_nonstream = '''retryResult = await attemptSqlWithRetry(\n            execPool,\n            parsed.sql ?? generationResult.sql ?? '',\n            systemPrompt,\n            createChatModel(\n              keyRecord.provider,\n              keyRecord.api_key,\n              getChatModelConfig(keyRecord.provider, keyRecord.api_key, model),\n            ),\n            2,\n            req.userId!,\n            connection.id,\n            focusedSchema,\n            message,\n            enrichedSchema,\n          );'''
after = after.replace(old_nonstream, new_nonstream)

result = before + after
with open(r'D:\Phuong\workspace\ai-data-platform\server\src\routes\chat.ts', 'w', encoding='utf-8') as f:
    f.write(result)
print('File updated')
