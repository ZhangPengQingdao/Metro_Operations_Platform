const SIGNATURE_TASK = /^\/employee\/app\/signatures\/sign(?:\/|\?task=)([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/** Only signature task links may resume after employee sign-in. Normalize old links to the current route. */
export function employeeLoginDestination(requested: unknown): string {
 const match = typeof requested === 'string' ? SIGNATURE_TASK.exec(requested) : null;
 return match && match[0] === requested ? `/employee/app/signatures/sign/${match[1]}` : '/employee';
}
