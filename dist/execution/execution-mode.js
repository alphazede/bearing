export const EXECUTION_MODES = ["explorer", "expedition"];
export function recommendExecutionMode(input) {
    if (![input.workItems, input.maxCrewmatesPerExplorer, input.perAgentTokenEstimate].every((value) => Number.isSafeInteger(value) && value > 0) || (input.overrideMode !== undefined && !EXECUTION_MODES.includes(input.overrideMode)))
        throw new TypeError("invalid recommendation input");
    const recommendedMode = input.workItems <= input.maxCrewmatesPerExplorer ? "explorer" : "expedition";
    const selectedMode = input.overrideMode ?? recommendedMode;
    const explorers = selectedMode === "explorer" ? 1 : Math.ceil(input.workItems / input.maxCrewmatesPerExplorer);
    const estimatedAgents = input.workItems + explorers + (selectedMode === "expedition" ? 1 : 0);
    return {
        recommendedMode, selectedMode, overridden: selectedMode !== recommendedMode, estimatedAgents,
        estimatedTokens: estimatedAgents * input.perAgentTokenEstimate,
        tradeoffs: selectedMode === "explorer"
            ? { tokens: "lower manager token overhead", coordination: "one Explorer coordinates all Crewmates" }
            : { tokens: "higher Navigator and Explorer token overhead", coordination: "bounded Explorer groups reduce coordination fan-out" },
        launchAuthorized: false,
    };
}
