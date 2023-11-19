import * as React from 'react';
import { useState } from 'react';
import { Box, Button, Accordion, AccordionSummary, AccordionDetails, AccordionGroup, Typography, useTheme } from '@mui/joy';

export interface Field {
  name: string;
  type: string;
  mode: string;
  description: string;
}

export interface Schema {
  fields: Field[];
}

export const RenderSchema = ({ schema }: { schema: Schema }) => {
  const theme = useTheme();
  const [isOpen, setIsOpen] = useState(false);

  const handleToggle = () => {
    setIsOpen(!isOpen);
  };
  if (!schema?.fields || schema.fields.length === 0) {
    return (
      <Box className={`schema-body ${theme.palette.mode === 'dark' ? 'schema-body-dark' : 'schema-body-light'}`}>
        <Typography level="title-md">Failed to fetch schema</Typography>
        <Typography level="body-sm">
          LLM might have requested an schema that doesn't exist or was deleted
        </Typography>
      </Box>
    );
  }

  return (
    <Box className={`schema-body ${theme.palette.mode === 'dark' ? 'schema-body-dark' : 'schema-body-light'}`}>
      <AccordionGroup transition="0.2s ease">
        <Accordion expanded={isOpen} onChange={handleToggle} >
          <AccordionSummary >
            <Box flexDirection="column">
              <Typography level="title-md">Received Schema</Typography>
              <Typography level="body-sm">
                Click to expand schema
              </Typography>
            </Box>
          </AccordionSummary>
          <AccordionDetails>
            <Box
              component="table"
              sx={{
                width: '100%',
                '& th, & td': {
                  padding: '8px',
                  textAlign: 'left',
                  borderBottom: '1px solid #555'
                },
              }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Mode</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {schema.fields.map((field, index) => (
                  <tr key={index}>
                    <td>{field.name}</td>
                    <td>{field.type}</td>
                    <td>{field.mode}</td>
                    <td>{field.description}</td>
                  </tr>
                ))}
              </tbody>
            </Box>
          </AccordionDetails>
        </Accordion>
      </AccordionGroup>
    </Box>
  );
}
