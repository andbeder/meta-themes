# Salesforce LM Studio Processor

A Node.js application that scans Salesforce objects for specific records defined in a CSV file, processes one or more specified fields with LM Studio, and outputs results to CSV.

## Features

- Connects to Salesforce using existing JWT authentication
- Reads a CSV file to get a list of specific records to query
- Queries Salesforce objects for records matching the CSV filter criteria
- Processes one or multiple specified fields with LM Studio using custom prompts
- Retrieves field metadata from Salesforce to include field labels for context
- Combines multiple fields with their labels before sending to LM Studio
- **Resumable processing**: Automatically skips already processed records from existing output files
- **Real-time output**: Appends results to CSV immediately after each record is processed
- **Interrupt-safe**: Can be stopped and restarted without losing progress
- Handles large datasets with automatic chunking (IN clause limits) and pagination
- Outputs results to CSV including Salesforce Record ID, filter field value, original text, and LM Studio response
- Handles errors gracefully and continues processing

## Prerequisites

1. **Node.js** (v14 or higher)
2. **LM Studio** running locally on default port 1234
3. **Salesforce Environment Variables** (same as used by sfdcAuth.js):
   - `SFDC_CLIENT_ID`
   - `SFDC_USERNAME`
   - `SFDC_PRIVATE_KEY`
   - `KEY_PASS`
   - `SFDC_TOKEN_URL` (optional, defaults to login.salesforce.com)
   - `KEY_PBKDF2` (optional, set to '1' if using PBKDF2)

## Installation

1. Clone or download this repository
2. Install dependencies:
   ```bash
   npm install
   ```

## Usage

```bash
node index.js <salesforce-object> <field-names> <prompt> <csv-file>
```

Where `<field-names>` can be:
- A single field: `Q6_Recognition_Thoughts__c`
- Multiple fields (comma-separated): `Q6_Recognition_Thoughts__c,Q4_Supervisor_Skills__c`

### Examples

#### Single Field
```bash
node index.js Employee_Survey_Response__c Q6_Recognition_Thoughts__c "Extract meta-themes from this survey response" survey-ids.csv
```

#### Multiple Fields
```bash
node index.js Employee_Survey_Response__c Q6_Recognition_Thoughts__c,Q4_Supervisor_Skills__c "Extract meta-themes from this survey response" survey-ids.csv
```

This will:
1. Read `survey-ids.csv` to get a list of Employee_Record_ID__c values
2. Query `Employee_Survey_Response__c` records where `Employee_Record_ID__c` matches the CSV values
3. Retrieve field metadata from Salesforce to get field labels
4. For multiple fields, combine them with labels (e.g., "Recognition Thoughts: [content]\n\nSupervisor Skills: [content]")
5. Send the combined text to LM Studio with the specified prompt
6. Save results to `Employee_Survey_Response__c_Q6_Recognition_Thoughts__c_Q4_Supervisor_Skills__c_results.csv`

### Resume Functionality
The application supports resumable processing:
- If you stop the job (Ctrl+C) and restart it, it will automatically skip already processed records
- Results are written to the CSV file immediately after each record is processed
- The system reads existing output files and excludes those record IDs from processing
- Perfect for large datasets or when LM Studio connections are unreliable

**Example resume scenario:**
```bash
# Initial run processes 50 out of 200 records, then you stop it
node index.js Employee_Survey_Response__c Q6_Recognition_Thoughts__c "Extract themes" survey-ids.csv
# Processes records 1-50, then stopped

# Restart the same command
node index.js Employee_Survey_Response__c Q6_Recognition_Thoughts__c "Extract themes" survey-ids.csv
# Output: "Found existing output file with 50 already processed records"
# Output: "Filtered 50 already processed records. 150 remaining to process."
# Continues with records 51-200
```

### CSV File Format

The CSV file should have a header row with the field name to filter by, followed by the values:

```csv
Employee_Record_ID__c
10005283
10005284
10005285
```

The first column header will be used as the filter field name in the Salesforce query.

## Configuration

### LM Studio URL
By default, the app connects to LM Studio at `http://localhost:1234/v1/chat/completions`. You can override this with the `LM_STUDIO_URL` environment variable:

```bash
export LM_STUDIO_URL=http://localhost:8080/v1/chat/completions
node index.js ...
```

### Query Limit
The app currently limits queries to 200 records. You can modify this in the `querySalesforceRecords` function in `index.js`.

### Field Processing
- **Single Field**: Sends the field content directly to LM Studio
- **Multiple Fields**: Retrieves field labels from Salesforce metadata and combines fields as:
  ```
  Field Label 1: Content from field 1

  Field Label 2: Content from field 2
  ```
- Only fields with non-empty content are included in the combined text
- If all specified fields are empty for a record, that record is skipped

### CSV File Processing
The app reads the first column of the CSV file as the filter field and uses all non-empty values for filtering Salesforce records.

## Output

Results are saved to a CSV file named `{ObjectName}_{FieldName}_results.csv` with columns:
- **Salesforce Record ID**: The unique ID of the Salesforce record
- **Filter Field**: The value from the CSV filter field (e.g., Employee_Record_ID__c)
- **Original Text**: The content of the specified field
- **LM Studio Response**: The response from LM Studio

## Error Handling

- Records with empty/null field values are skipped
- LM Studio API errors are captured and included in the CSV output
- Network timeouts are set to 30 seconds for LM Studio requests
- Salesforce authentication errors will stop the process

## Troubleshooting

1. **Salesforce Authentication Issues**: Ensure all required environment variables are set correctly
2. **LM Studio Connection Issues**: Verify LM Studio is running and accessible at the configured URL
3. **Field Not Found**: Ensure the field name exists on the specified Salesforce object
4. **Permission Issues**: Ensure your Salesforce user has read access to the specified object and field
5. **Resume Issues**: If resume detection isn't working, check that the output CSV file has the correct column headers
6. **Large Datasets**: For very large datasets (>20,000 records), the system automatically chunks queries to respect Salesforce limits