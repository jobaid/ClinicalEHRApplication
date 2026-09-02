import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "../App";

describe("Clinical EHR Login", () => {
  it("renders the login screen", () => {
    render(<App />);

    expect(
      screen.getByText(/login|sign in/i)
    ).toBeInTheDocument();
  });
});