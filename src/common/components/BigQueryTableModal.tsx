
import React, { useCallback, useMemo, useRef, useState, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AgGridReact } from 'ag-grid-react';
import 'ag-grid-enterprise';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-alpine.css';
import { Modal, ModalDialog, ModalOverflow } from '@mui/joy';
import { IServerSideGetRowsParams, IServerSideGetRowsRequest, GridReadyEvent } from 'ag-grid-community';

interface BigQueryTableProps {
    open: boolean;
    onClose: () => void;
    data: BigQueryResponse & { fetchNextPage: (request: IServerSideGetRowsRequest) => Promise<BigQueryResponse> };
    pageSize?: number;
}

interface BigQueryResponse {
    schema: {
        fields: Array<{
            name: string;
            type: string;
            mode: string;
        }>;
    };
    rows: Array<{
        f: Array<{
            v: any;
        }>;
    }>;
    totalRows: string;
}

function convertBigQueryDataToColumns(data: BigQueryResponse) {
    return data.schema.fields.map((field) => ({
        // headerName: field.name.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
        headerName: field.name,
        field: field.name,
        sortable: true,
        filter: true,
        resizable: true,
        // width: field.type === 'STRING' ? 150 : 100,
    }));
}

function convertBigQueryDataToRows(data: BigQueryResponse) {
    return data.rows.map((row, index) => {
        const rowData: { [key: string]: any } = { id: index };
        row.f.forEach((cell, cellIndex) => {
            const columnName = data.schema.fields[cellIndex].name;
            rowData[columnName] = cell.v;
        });
        return rowData;
    });
}

const getServerSideDatasource = (bigQueryData: BigQueryResponse & {
    fetchNextPage: (request: IServerSideGetRowsRequest) => Promise<BigQueryResponse>
}) => {
    return {
        getRows: (params: IServerSideGetRowsParams) => {
            console.log('[Datasource] - rows requested by grid: ', params.request);
            bigQueryData.fetchNextPage(params.request).then(response => {
                console.log('fetchNextPage response', response)
                setTimeout(() => {
                    params.success({
                        rowData: convertBigQueryDataToRows(response),
                        rowCount: parseInt(response.totalRows),
                    });
                }, 200);
            }).catch((e) => {
                console.log('[Datasource] - error: ', e);
                params.fail();
            });
        },
    };
};

const PAGE_SIZE = 100

export function BigQueryTableModal({
    open,
    onClose,
    data,
    pageSize = PAGE_SIZE,
}: BigQueryTableProps) {

    const onGridReady = useCallback((params: GridReadyEvent) => {
        const datasource = getServerSideDatasource(data);
        params.api.setServerSideDatasource(datasource);
        params.columnApi.autoSizeAllColumns();
    }, [data]);

    const columns = convertBigQueryDataToColumns(data);

    const gridRef = useRef(null);
    return (
        <StrictMode>
            <Modal open={open} onClose={onClose}>
                <ModalOverflow>
                    <ModalDialog sx={{ width: '85vw' }}>
                        <div className="ag-theme-alpine" style={{ height: '85vh', width: '100%' }}>
                            <AgGridReact
                                ref={gridRef}
                                columnDefs={columns}
                                rowModelType="serverSide"
                                serverSideStoreType="partial"
                                pagination={true}
                                rowSelection='multiple'
                                suppressRowClickSelection={true}
                                paginationPageSize={pageSize}
                                cacheBlockSize={pageSize}
                                onGridReady={onGridReady}
                            />
                        </div>
                    </ModalDialog>
                </ModalOverflow>
            </Modal>
        </StrictMode>
    );
}