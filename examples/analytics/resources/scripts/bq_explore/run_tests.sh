#!/bin/bash
# Automated test suite for bq_explore.py SQL executor

SCRIPT="./bq_explore.py"
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0

echo "========================================"
echo "bq_explore.py Test Suite"
echo "========================================"
echo ""

# Helper function to run a test
run_test() {
    local test_name="$1"
    local command="$2"
    local expected="$3"
    local check_type="$4"  # "exit_code", "output_contains", or "output_not_contains"

    echo -e "${BLUE}TEST: $test_name${NC}"
    echo "bash: $command"
    echo "expected: $expected"

    # Run command and capture output and exit code
    output=$(eval "$command" 2>&1)
    exit_code=$?

    # Check result based on type
    if [ "$check_type" == "exit_code" ]; then
        if [ $exit_code -eq $expected ]; then
            echo -e "actual: exit code $exit_code ${GREEN}✓ PASS${NC}"
            ((PASSED++))
        else
            echo -e "actual: exit code $exit_code ${RED}✗ FAIL${NC}"
            ((FAILED++))
        fi
    elif [ "$check_type" == "output_contains" ]; then
        if echo "$output" | grep -q "$expected"; then
            echo -e "actual: output contains '$expected' ${GREEN}✓ PASS${NC}"
            ((PASSED++))
        else
            echo -e "actual: output does NOT contain '$expected' ${RED}✗ FAIL${NC}"
            echo "--- Output preview ---"
            echo "$output" | head -10
            ((FAILED++))
        fi
    elif [ "$check_type" == "output_not_contains" ]; then
        if echo "$output" | grep -q "$expected"; then
            echo -e "actual: output contains '$expected' (expected NOT to) ${RED}✗ FAIL${NC}"
            echo "--- Output preview ---"
            echo "$output" | head -10
            ((FAILED++))
        else
            echo -e "actual: output does NOT contain '$expected' ${GREEN}✓ PASS${NC}"
            ((PASSED++))
        fi
    fi

    echo ""
}

# Test 1: Simple COUNT query succeeds
run_test \
    "Simple COUNT query on real table succeeds" \
    "$SCRIPT 'SELECT count(*) as row_count FROM evenup-bi.dbt_bgu.dim_cal_biz_hours'" \
    "0" \
    "exit_code"

# Test 2: SELECT output shows success message
run_test \
    "Success message displayed" \
    "$SCRIPT 'SELECT count(*) as row_count FROM evenup-bi.dbt_bgu.dim_cal_biz_hours'" \
    "✅ Query completed" \
    "output_contains"

# Test 3: Output shows row count
run_test \
    "Output shows row count" \
    "$SCRIPT 'SELECT count(*) as row_count FROM evenup-bi.dbt_bgu.dim_cal_biz_hours'" \
    "Rows:" \
    "output_contains"

# Test 4: Output shows bytes billed
run_test \
    "Output shows bytes billed" \
    "$SCRIPT 'SELECT count(*) as row_count FROM evenup-bi.dbt_bgu.dim_cal_biz_hours'" \
    "Bytes billed:" \
    "output_contains"

# Test 5: Output shows column names
run_test \
    "Output shows column names" \
    "$SCRIPT 'SELECT count(*) as row_count FROM evenup-bi.dbt_bgu.dim_cal_biz_hours'" \
    "Columns:" \
    "output_contains"

# Test 6: Output shows CSV file path
run_test \
    "Output shows results file path" \
    "$SCRIPT 'SELECT count(*) as row_count FROM evenup-bi.dbt_bgu.dim_cal_biz_hours'" \
    "Results written to:" \
    "output_contains"

# Test 7: DELETE query rejected
run_test \
    "DELETE query rejected" \
    "$SCRIPT 'DELETE FROM evenup-bi.dbt_bgu.dim_cal_biz_hours'" \
    "1" \
    "exit_code"

# Test 8: DELETE error message
run_test \
    "DELETE error mentions non-SELECT" \
    "$SCRIPT 'DELETE FROM evenup-bi.dbt_bgu.dim_cal_biz_hours'" \
    "QUERY REJECTED" \
    "output_contains"

# Test 9: INSERT query rejected
run_test \
    "INSERT query rejected" \
    "$SCRIPT 'INSERT INTO evenup-bi.dbt_bgu.dim_cal_biz_hours VALUES (1)'" \
    "1" \
    "exit_code"

# Test 10: INSERT error message
run_test \
    "INSERT error mentions non-SELECT" \
    "$SCRIPT 'INSERT INTO evenup-bi.dbt_bgu.dim_cal_biz_hours VALUES (1)'" \
    "QUERY REJECTED" \
    "output_contains"

# Test 11: DROP query rejected
run_test \
    "DROP query rejected" \
    "$SCRIPT 'DROP TABLE evenup-bi.dbt_bgu.dim_cal_biz_hours'" \
    "1" \
    "exit_code"

# Test 12: WITH (CTE) accepted with real table
run_test \
    "WITH (CTE) query with real table accepted" \
    "$SCRIPT 'WITH cte AS (SELECT count(*) as cnt FROM evenup-bi.dbt_bgu.dim_cal_biz_hours) SELECT * FROM cte'" \
    "0" \
    "exit_code"

# Test 13: Query over byte limit rejected
run_test \
    "Query over byte limit rejected" \
    "$SCRIPT 'SELECT * FROM evenup-bi.dbt_bgu.ttx_llm_call_events' --max-gb 0.00001" \
    "1" \
    "exit_code"

# Test 14: Query over byte limit shows error
run_test \
    "Byte limit error message shown" \
    "$SCRIPT 'SELECT * FROM evenup-bi.dbt_bgu.ttx_llm_call_events' --max-gb 0.00001" \
    "QUERY TOO LARGE" \
    "output_contains"

# Test 15: Real multi-column query succeeds
run_test \
    "Multi-column query on real table" \
    "$SCRIPT 'SELECT * FROM evenup-bi.dbt_bgu.dim_cal_biz_hours LIMIT 5'" \
    "0" \
    "exit_code"

# Test 16: Real query produces multiple rows
run_test \
    "Query produces expected data" \
    "$SCRIPT 'SELECT * FROM evenup-bi.dbt_bgu.mart_firm_salesforce_attributes LIMIT 10'" \
    "Rows:" \
    "output_contains"

echo "========================================"
echo -e "${GREEN}PASSED: $PASSED${NC}"
echo -e "${RED}FAILED: $FAILED${NC}"
echo "========================================"

if [ $FAILED -gt 0 ]; then
    exit 1
else
    exit 0
fi
