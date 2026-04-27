import { Request, Response, NextFunction } from "express";

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
	const start = Date.now();
	res.on("finish", () => {
		const ms = Date.now() - start;
		const user = req.user?.username ?? "unauthenticated";
		console.log(
			`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ` +
			`${res.statusCode} ${ms}ms user=${user}`
		);
	});
	next();
}