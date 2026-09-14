// Application-side module: depends only on the public injected SDK client.
export async function loadGreeting(client, name) {
  const result = await client.invoke('sample.greeting', { name });
  if (!result || typeof result !== 'object' || typeof result.message !== 'string') {
    throw new Error('Invalid greeting result');
  }
  return result.message;
}
