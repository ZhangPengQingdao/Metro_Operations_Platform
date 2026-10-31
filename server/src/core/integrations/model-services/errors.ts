export class ModelServiceError extends Error {
 constructor(readonly code:string,message:string,readonly statusCode=400){super(message);}
}
